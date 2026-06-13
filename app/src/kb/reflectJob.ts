// The Reflect job behavior (SPEC-0024) — the first real job on the JOBS engine (SPEC-0023). It
// selects a BOUNDED working set (never the whole KB; REFLECT-2), runs the reflect decider over it,
// and maps the findings onto the engine's `JobFinding` shape — the JobStage runner then enforces
// posture (additive-high-conf→auto / destructive|low-conf→Review; REFLECT-4/5), journals, audits,
// and promotes. The behavior owns NO canonical writes and makes NO external calls (JOBS-10).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findEntityFiles } from './claimsStage';
import { parseEntityNode } from './connectDoc';
import type { JobBehavior, JobFinding, JobPassResult } from './jobs';
import type { ReflectDecider, ReflectNode, ReflectResult } from './reflectAgent';

/** The registry `type` that selects the Reflect behavior (SPEC-0024). */
export const REFLECT_JOB_TYPE = 'reflect';

/** Max nodes fed to one rumination pass (REFLECT-2 bounded; ~15/run v1 default, tunable). */
export const REFLECT_WORKING_SET_SIZE = 15;

interface ReflectCursor {
  offset: number; // round-robin position into the sorted entity list (aged sampling coverage)
  count: number; // entity count at last run (a cheap churn/growth signal)
}

/** Read a node's identity + a short body excerpt for the agent's context (bounded — only the slice). */
async function toReflectNode(root: string, rel: string): Promise<ReflectNode | null> {
  let md: string;
  try {
    md = await fs.readFile(path.join(root, rel), 'utf8');
  } catch {
    return null; // node vanished between listing and read — skip
  }
  let parsed;
  try {
    parsed = parseEntityNode(md);
  } catch {
    return null; // foreign/malformed node — skip
  }
  const fmEnd = md.indexOf('\n---', 3);
  const body = fmEnd === -1 ? '' : md.slice(fmEnd + 4).replace(/^\s*#[^\n]*\n?/, '').trim();
  return { rel, name: parsed.name, kind: parsed.kind, tags: parsed.tags, excerpt: body.slice(0, 240) };
}

/**
 * Build the Reflect `JobBehavior` around a decider (injected; production = `makeReflectDecider()`,
 * tests pass a deterministic one). Each pass: pick a bounded slice (round-robin aged sampling via
 * the journal cursor, with a churn signal to the agent when the KB grew), ruminate, map findings.
 */
export function makeReflectJobBehavior(decider: ReflectDecider): JobBehavior {
  return async (ctx): Promise<JobPassResult> => {
    const rels = (await findEntityFiles(ctx.root)).sort();
    const prev = (ctx.journal[ctx.journal.length - 1]?.cursor ?? {}) as Partial<ReflectCursor>;
    const prevOffset = typeof prev.offset === 'number' ? prev.offset : 0;
    const prevCount = typeof prev.count === 'number' ? prev.count : 0;

    // Empty KB → graceful no-op pass (still journaled by the runner). REFLECT-6.
    if (rels.length === 0) {
      return { inspected: 'reflect: empty KB (no entities)', findings: [], cursor: { offset: 0, count: 0 } };
    }

    // Aged sampling: a bounded, rotating slice via the cursor (coverage accrues over runs, never
    // the whole KB at once; REFLECT-2). Wrap around the end so every corner is eventually revisited.
    const offset = prevOffset % rels.length;
    const slice = [...rels.slice(offset, offset + REFLECT_WORKING_SET_SIZE)];
    if (slice.length < REFLECT_WORKING_SET_SIZE && rels.length > REFLECT_WORKING_SET_SIZE) {
      slice.push(...rels.slice(0, REFLECT_WORKING_SET_SIZE - slice.length));
    }
    const workingSet = (await Promise.all(slice.map((rel) => toReflectNode(ctx.root, rel)))).filter((n): n is ReflectNode => n !== null);

    // Continuity (JOBS-7) + a cheap churn hint (REFLECT-2: lean into churn when the KB grew).
    const journalNotes = ctx.journal.slice(-3).map((j) => `${j.ts}: ${j.inspected}`);
    if (rels.length > prevCount) journalNotes.push(`(churn) KB grew ${prevCount}→${rels.length} entities since last run — favor newly-emerged structure`);

    const nextOffset = (offset + REFLECT_WORKING_SET_SIZE) % rels.length;

    // REFLECT-18 crash-robustness: a bad agent pass (unparseable output → the live `job.failed
    // JSON.parse SyntaxError`, or any decider/agent error) must NOT kill the Reflect job. Set this
    // slice ASIDE — advance the cursor so the next scheduled pass moves on (not re-stuck on the same
    // ~2% of nodes) — journal the skip, and continue. The slice is naturally revisited next full cycle
    // (aged sampling wraps). Never fabricate a finding from a failed pass.
    let result: ReflectResult;
    try {
      result = await decider({ workingSet, journalNotes });
    } catch (err) {
      return {
        inspected: `reflect: skipped a slice — agent pass failed (${err instanceof Error ? err.message : String(err)}) [${workingSet.length}/${rels.length} nodes @offset ${offset}]`,
        findings: [],
        cursor: { offset: nextOffset, count: rels.length },
      };
    }

    const findings: JobFinding[] = result.findings.map((f) => ({
      summary: f.summary,
      kind: f.kind,
      confidence: f.confidence,
      proposed: f.kind === 'additive' ? 'auto' : 'review', // runner re-enforces posture (REFLECT-5)
      ...(f.writes ? { writes: f.writes } : {}),
      ...(f.review ? { review: f.review } : {}),
    }));

    return {
      inspected: `${result.inspected} [${workingSet.length}/${rels.length} nodes @offset ${offset}]`,
      findings,
      cursor: { offset: nextOffset, count: rels.length },
    };
  };
}
