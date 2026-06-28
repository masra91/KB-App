// RMEM (SPEC-0054) — the researcher's DURABLE, FIRST-CLASS run-ledger. RESEARCH-QUALITY slice-1 (#381)
// gave the researcher cross-run angle rotation + a frontier, but that memory was DERIVED from the audit
// (`deriveNotebook` reads `researched`/`no-finding` events). SPEC-0054 makes the memory first-class: a
// per-researcher ledger the run phase WRITES directly — "a re-applied overlay, not decomposed as a source"
// (RMEM-7) — so it is authoritative run-memory that doesn't depend on the audit staying intact, and it
// survives restart + replay (it lives under `.kb/research/<id>/`, which is neither gitignored nor in the
// replay clean-scope, so a `git reset --hard` + scoped clean leaves it untouched — RMEM-2/7).
//
// Each entry records ONE run: the target (what + entity), the GAP FACET it pursued, the angle it steered
// on, the source ids it harvested, and the outcome. A new run consults the ledger to (a) skip a covered
// (target × gap-facet × angle) tuple (RMEM-3) and (b) resume the frontier of leads seen-but-not-pursued
// (RMEM-4). Bounded + self-healing (newest-N, stale entries age out) like the field notebook.
//
// EGRESS (RMEM-6 / D6a): the ledger is LOCAL run metadata — facet labels, angles, source ids. It is an
// input to angle/gap selection ONLY; it is NEVER dumped into an outbound query (the egress query is still
// built solely through buildOutboundQuery from the request + the bounded gap steer).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isSafeResearcherId, normalizeTerm } from './researchers';
import { areaKey, NOTEBOOK_STALE_MS } from './researchNotebook';

/** One recorded research run (RMEM-2). `gapFacet` is the missing facet the run aimed at (when the angle
 *  filled a gap); `angle` is the steer actually used; `harvested` are the source ids the run produced. */
export interface RunLedgerEntry {
  /** The target subject (the request's `what`) — normalized into the area key together with `entityId`. */
  target: string;
  /** The entity the run was about, when the request named one (part of the stable target key). */
  entityId?: string;
  /** The missing gap facet the run pursued (RMEM-1/3) — absent when the angle wasn't a gap facet. */
  gapFacet?: string;
  /** The angle the run actually steered on (the decorated steer, e.g. `re Ada Lovelace: education`). */
  angle: string;
  /** Source ids harvested by the run (RMEM-2) — the result-level memory of what it already pulled. */
  harvested: string[];
  /** The run's outcome (mirrors the audit's outcome taxonomy). */
  outcome: 'finding' | 'no-finding' | 'failed';
  /** When the run happened (ms epoch) — drives staleness so an old facet can legitimately re-open. */
  ts: number;
}

/** A researcher's durable run-ledger — the ordered runs it has performed (newest-first after bounding). */
export interface ResearchLedger {
  researcherId: string;
  runs: RunLedgerEntry[];
}

/** Keep the newest N runs (the ledger is a bounded working memory, not an unbounded archive). */
export const LEDGER_RUNS_CAP = 500;

/** Absolute path to a researcher's run-ledger. Sibling of the field notebook; durable (not under
 *  `.kb/cache/`, not in the replay clean-scope) so it survives restart + replay (RMEM-2/7). */
export function ledgerPath(root: string, researcherId: string): string {
  return path.join(path.resolve(root), '.kb', 'research', researcherId, 'ledger.json');
}

const empty = (researcherId: string): ResearchLedger => ({ researcherId, runs: [] });

function isEntry(v: unknown): v is RunLedgerEntry {
  const o = v as RunLedgerEntry;
  return !!o && typeof o.target === 'string' && typeof o.angle === 'string' && typeof o.ts === 'number';
}

/** Read the persisted ledger (graceful empty on missing/malformed — self-healing, never throws). */
export async function readLedger(root: string, researcherId: string): Promise<ResearchLedger> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(ledgerPath(root, researcherId), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Partial<ResearchLedger>;
      return { researcherId, runs: Array.isArray(o.runs) ? o.runs.filter(isEntry) : [] };
    }
  } catch {
    /* missing/corrupt → empty ledger (self-healing) */
  }
  return empty(researcherId);
}

/** Keep the newest {@link LEDGER_RUNS_CAP} runs (pure + idempotent). */
export function boundLedger(ledger: ResearchLedger): ResearchLedger {
  return { researcherId: ledger.researcherId, runs: [...ledger.runs].sort((a, b) => b.ts - a.ts).slice(0, LEDGER_RUNS_CAP) };
}

/** Persist the ledger (id slug-guarded before any path is touched — #29). */
export async function writeLedger(root: string, ledger: ResearchLedger): Promise<void> {
  if (!isSafeResearcherId(ledger.researcherId)) throw new Error(`refusing to write ledger for unsafe researcher id: ${JSON.stringify(ledger.researcherId)}`);
  const p = ledgerPath(root, ledger.researcherId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(boundLedger(ledger), null, 2) + '\n', 'utf8');
}

/** Append one run to a researcher's ledger (read-modify-write, bounded). The durable write the run phase
 *  makes on every pass (RMEM-2) — newest run wins on read. Best-effort caller (never block a pass on it). */
export async function appendRun(root: string, researcherId: string, entry: RunLedgerEntry): Promise<void> {
  const ledger = await readLedger(root, researcherId);
  ledger.runs.unshift(entry);
  await writeLedger(root, ledger);
}

/** Clear a researcher's ledger cleanly — invoked on a hard reset so no stale run-memory is carried as a
 *  graveyard (RMEM-7). Idempotent; tolerant of an absent file. */
export async function clearLedger(root: string, researcherId: string): Promise<void> {
  await fs.rm(ledgerPath(root, researcherId), { force: true }).catch(() => {});
}

/** Remove ALL of a researcher's local run-memory dir (`.kb/research/<id>/` — ledger + field notebook) so a
 *  DELETED researcher leaves no graveyard (RMEM-7). The memory is derived working state, not ground truth
 *  (sources/findings + audit are kept by the caller). Id-guarded (#29); idempotent; never throws. */
export async function clearResearchMemory(root: string, researcherId: string): Promise<void> {
  if (!isSafeResearcherId(researcherId)) throw new Error(`refusing to clear research memory for unsafe id: ${JSON.stringify(researcherId)}`);
  await fs.rm(path.dirname(ledgerPath(root, researcherId)), { recursive: true, force: true }).catch(() => {});
}

/**
 * The angles a target has ALREADY been drilled on within the staleness window (RMEM-3). Orient feeds these
 * to `chooseAngle` as the exclusion set so a re-run ROTATES to a different missing facet instead of
 * re-issuing a covered (target × gap-facet × angle) tuple. Stale runs age out, so a long-untouched facet
 * legitimately re-opens. Keyed exactly like the notebook's areas (normalized `what` + entityId).
 */
export function coveredAngles(ledger: ResearchLedger, target: string, entityId: string | undefined, nowMs: number): string[] {
  const key = areaKey(target, entityId);
  const out: string[] = [];
  for (const r of ledger.runs) {
    if (areaKey(r.target, r.entityId) !== key) continue;
    if (r.outcome === 'failed') continue; // a failed pass (egress error) didn't drill the facet → don't suppress a retry
    if (nowMs - r.ts >= NOTEBOOK_STALE_MS) continue; // stale → re-opens
    if (r.angle.trim().length > 0) out.push(r.angle);
  }
  return [...new Set(out)];
}

/** The set of source ids the researcher has already harvested across all runs (result-level dedup, RMEM-2). */
export function harvestedSourceIds(ledger: ResearchLedger): Set<string> {
  return new Set(ledger.runs.flatMap((r) => r.harvested));
}

/**
 * The still-open FRONTIER from the ledger (RMEM-4): of a target's known missing gap facets (passed in from
 * the request's gap descriptor), the ones NO non-stale run has pursued yet — the leads to resume. Pure;
 * the caller supplies the gap's `missing` facets (run-metadata steering, never raw KB content — RMEM-6).
 */
export function frontierFacets(ledger: ResearchLedger, target: string, entityId: string | undefined, missingFacets: readonly string[], nowMs: number): string[] {
  const drilled = coveredAngles(ledger, target, entityId, nowMs).map((a) => a.toLowerCase());
  return missingFacets.filter((f) => f.trim().length > 0 && !drilled.some((a) => a.includes(f.toLowerCase())));
}

/** A stable covered-tuple key for a run (target × gap-facet × angle) — the unit RMEM-3 must not repeat. */
export function runTupleKey(entry: Pick<RunLedgerEntry, 'target' | 'entityId' | 'gapFacet' | 'angle'>): string {
  return `${areaKey(entry.target, entry.entityId)}::${normalizeTerm(entry.gapFacet ?? '')}::${normalizeTerm(entry.angle)}`;
}
