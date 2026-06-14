// SPEC-0028 RESEARCH-3 / WS-B — the enrichment TRIGGER: the missing producer that makes the research
// pipeline non-inert. The dispatcher, the persistent dedup ledger, and the warm-start orient all work
// — but NOTHING ever emitted a `research-request`, so a registered+enabled researcher had no work and
// `outputs/` stayed empty. This scans the resolved entity graph and emits one `research-request` per
// SPARSE ("little reference") entity — one corroborated by only a single source — so a Web researcher
// enriches it with an external reference.
//
// Deterministic by design (no LLM → no brittle-JSON parse failure, matching the SPEC-0049 robustness
// ethos). Idempotent: an entity already carrying a pending `research-request` (same dedupKey) is
// skipped, and the dispatcher's `seen.json` ledger backstops cross-sweep dedup — so re-running the
// sweep never re-fans research nor bloats the audit. The emitted signal lands in the cross-cutting
// control audit (`.kb/audit.jsonl`) as the `enrich` actor, where `collectResearchRequests` reads it
// back into a `ResearchRequest` for the dispatcher (the same path a stage-emitted signal travels).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAuditEvent } from './audit';
import { parseEntityNode, type ParsedNode } from './connectDoc';
import { RESEARCH_REQUEST_SIGNAL, dedupKeyFor } from './researchers';

/**
 * The max corroborating-source count at which an entity is "sparse" / a "little reference" worth
 * enriching (WS-B). `<= 1` = mentioned by only a single source — a stub the KB can't yet
 * cross-corroborate; the natural enrichment target. A named constant so the SPEC-0028 amendment can
 * tune the threshold without hunting the logic.
 */
export const SPARSE_SOURCE_MAX = 1;

/** Is this resolved entity sparse (a "little reference" wanting external enrichment)? */
export function isSparseEntity(node: Pick<ParsedNode, 'derivedFrom'>): boolean {
  return node.derivedFrom.length <= SPARSE_SOURCE_MAX;
}

/** Recursively collect every entity node markdown file under `entities/` (vault-relative paths).
 *  Skips dotfiles/dirs and the `.gitkeep` scaffold; tolerant of a missing tree (empty result). */
async function walkEntityFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // no entities/ tree yet
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await rec(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(path.relative(root, full));
    }
  }
  await rec(path.join(root, 'entities'));
  return out;
}

export interface FlagSparseOptions {
  /** Inject the emitted-signal timestamp (tests/determinism); defaults to now via appendAuditEvent. */
  ts?: string;
}

/**
 * Scan the resolved entity graph and emit a `research-request` for each SPARSE entity that does not
 * already have one pending (RESEARCH-3, WS-B). `existingKeys` is the set of dedupKeys already in
 * flight (the caller passes `collectResearchRequests`' keys) so we never re-emit a request the
 * dispatcher would only dedup away — that keeps the control audit from growing every sweep. A
 * malformed/foreign node is skipped (ENG-16 per-item isolation), never crashes the scan. Returns the
 * number of new requests emitted.
 */
export async function flagSparseEntities(
  root: string,
  existingKeys: Set<string>,
  opts: FlagSparseOptions = {},
): Promise<number> {
  const rels = await walkEntityFiles(root);
  let emitted = 0;
  for (const rel of rels) {
    let node: ParsedNode;
    try {
      node = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
    } catch {
      continue; // malformed/foreign node — skip, don't crash the sweep (ENG-16)
    }
    if (!isSparseEntity(node)) continue;
    const by = { entityId: node.id };
    const dedupKey = dedupKeyFor({ what: node.name, by });
    if (existingKeys.has(dedupKey)) continue; // already requested (this sweep or a prior one)
    existingKeys.add(dedupKey); // guard against duplicate entity files within one sweep
    await appendAuditEvent(root, {
      actor: 'enrich',
      subjects: { entityId: node.id },
      eventType: 'signal',
      payload: {
        type: RESEARCH_REQUEST_SIGNAL,
        what: node.name,
        why: `sparse entity — corroborated by only ${node.derivedFrom.length} source(s); enrich with an external reference`,
        context: `${node.kind}: ${node.name}`,
      },
      ...(opts.ts ? { ts: opts.ts } : {}),
    });
    emitted++;
  }
  return emitted;
}
