// One researcher run pass (SPEC-0028 RESEARCH-5/6/8/12) — substrate-agnostic orchestration behind
// the cognition seam. The actual external research (web fetch / SDK Session) is INJECTED as a
// `ResearchFn`, so this module is unit-testable without a network/SDK and the SDK adapter stays the
// only place that imports the runtime (mirrors recall.ts ↔ recallAgent.ts).
//
// SECURITY POSTURE (KB-QD's Slice-1 gates):
// - RESEARCH-8 (request-only egress): the outbound `query` is built from the request's `what`/
//   `context` ONLY — never arbitrary KB content (D6a). The query is passed to the ResearchFn; this
//   module never reads KB content to feed egress.
// - RESEARCH-12 (untrusted-content-as-DATA): the fetched finding is only ever written as a SOURCE
//   BODY + an audit payload — never interpreted as instructions here. It re-enters the pipeline as a
//   normal secondary source (Decompose→Connect→Claims), marked externally-sourced via provenance.
// - Path-containment: the finding is written via `captureToInbox`, which mints a system-controlled
//   ULID path (`inbox/<ulid>/`). No LLM-derived string ever becomes a filesystem path (the #52/#61/
//   #77 class). The researcher id that reaches `.kb/researchers/<id>` is slug-validated upstream.
import { captureToInbox } from './ingest';
import { appendAuditEvent } from './audit';
import { isSafeResearcherId, type ResearcherConfig, type ResearchRequest, type ResearchProvenance } from './researchers';

/** What the injected cognition returns. `found:false` = nothing worth recording (audited no-op). */
export interface ResearchFindings {
  /** Did the research surface anything worth recording as a secondary source? */
  found: boolean;
  /** The grounded, cited findings-note (markdown) — becomes the secondary source body. */
  note: string;
  /** External sources the note cites (URLs / external refs) — RESEARCH-6. */
  citations: string[];
  /** The outbound query actually used (built from the request only — D6a; recorded for audit). */
  query: string;
}

/** The cognition seam: run one external research pass for `r` answering `req`. Production = the Web
 *  SDK adapter (egress-gated, read-only, untrusted-content prompt); tests inject a deterministic fn. */
export type ResearchFn = (r: ResearcherConfig, req: ResearchRequest) => Promise<ResearchFindings>;

export interface RunResearcherDeps {
  research: ResearchFn;
  /** Injectable ISO clock (deterministic tests). */
  now?: () => string;
}

export interface RunResearcherResult {
  /** Secondary source ids produced (empty when the pass found nothing). */
  sourceIds: string[];
  /** One-liner outcome for the dispatcher's summary / caller audit. */
  note: string;
}

/**
 * Run `r` against `req`: research (injected) → on a finding, write a cited secondary source (ingest
 * path, contained ULID) that re-enters the pipeline, and emit a conforming `researcher` audit event;
 * on no finding, audit the no-op. Returns the source ids produced. Defensive: an unsafe researcher id
 * is refused before any path is touched (belt-and-suspenders over the registry guard).
 */
export async function runResearcher(root: string, r: ResearcherConfig, req: ResearchRequest, deps: RunResearcherDeps): Promise<RunResearcherResult> {
  if (!isSafeResearcherId(r.id)) throw new Error(`runResearcher: refusing unsafe researcher id ${JSON.stringify(r.id)}`);
  const now = deps.now ?? (() => new Date().toISOString());

  const findings = await deps.research(r, req);

  if (!findings.found || findings.note.trim().length === 0) {
    // RESEARCH-4: not relevant / nothing found → no-op, but audited (no silent actions, AUDIT-2).
    await appendAuditEvent(root, {
      actor: 'researcher',
      eventType: 'no-finding',
      ts: now(), // stamp with the pass's (injectable) clock — keeps audit ts == the run, not wall-clock
      subjects: { researcherId: r.id, requestId: req.id, ...(req.by.entityId ? { entityId: req.by.entityId } : {}), ...(req.by.sourceId ? { sourceId: req.by.sourceId } : {}) },
      payload: { what: req.what, why: req.why, query: findings.query, egressTier: r.egressTier },
    });
    return { sourceIds: [], note: 'no finding' };
  }

  const fetchedAt = now();
  const provenance: ResearchProvenance = {
    researcherId: r.id,
    requestId: req.id,
    query: findings.query,
    citations: findings.citations,
    fetchedAt,
  };
  // Contained write: ULID path, agent supplies only the body. origin:'secondary' → re-enters Decompose.
  const out = await captureToInbox(root, `researcher:${r.id}`, [{ kind: 'text', text: findings.note }], Date.parse(fetchedAt) || Date.now(), {
    origin: 'secondary',
    research: provenance,
  });

  await appendAuditEvent(root, {
    actor: 'researcher',
    eventType: 'researched',
    ts: fetchedAt, // == the pass clock (matches provenance.fetchedAt), not wall-clock
    subjects: { researcherId: r.id, requestId: req.id, sourceId: out.ids[0], ...(req.by.entityId ? { entityId: req.by.entityId } : {}) },
    payload: { what: req.what, why: req.why, query: findings.query, citations: findings.citations, egressTier: r.egressTier, externallySourced: true },
  });

  return { sourceIds: out.ids, note: `secondary source ${out.ids[0]} (${findings.citations.length} citation(s))` };
}

/**
 * Build the outbound query for a request — the ONLY KB-derived material a Slice-1 researcher may send
 * outbound (D6a / RESEARCH-8). Deliberately tiny + pure: the request's `what`, lightly grounded by
 * its `context`. Never reads entities/claims/sources. The SDK adapter calls this; exported for the
 * egress test that proves no arbitrary KB content leaks into the query.
 */
export function buildOutboundQuery(req: ResearchRequest): string {
  const what = req.what.trim();
  const ctx = req.context.trim();
  return ctx ? `${what} — ${ctx}` : what;
}
