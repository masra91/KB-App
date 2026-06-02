// The research dispatcher (SPEC-0028 RESEARCH-4) — the SOLE deterministic router (D5). Given a batch
// of `research-request`s (emitted on `signals[]` by any producer — pipeline stages or Reflect, D1)
// and the enabled researchers, it: dedups against a persistent ledger (D2), eligibility-filters
// (deterministic pre-filter, D3), caps fan-out, asks each eligible researcher to self-nominate (a
// cheap relevance check), and runs the nominated ones — bounded by the chain DEPTH limit (over-depth
// → escalate to Review, no egress) and a global ceiling, both RESEARCH-11.
//
// It is NOT an agent (out-of-scope §7): routing is deterministic + self-nomination. The cognition
// (self-nominate + run) is INJECTED behind a seam so this module stays substrate-agnostic and
// unit-testable; production wires the thin-CLI self-nomination + the SDK-Session research pass.
//
// Non-relevant researchers no-op + are recorded (RESEARCH-4: "not → no-op + audit"). The actual
// audit + secondary-source writes happen inside the injected `run` (which calls appendAuditEvent +
// the ingest path); the dispatcher returns a structured summary its caller audits/journals.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isEligible,
  RESEARCH_GLOBAL_CEILING,
  DEFAULT_MAX_FANOUT,
  type ResearcherConfig,
  type ResearchRequest,
} from './researchers';

/** Persistent dedup ledger location (working zone — never promoted). */
const SEEN_REL = path.join('.kb', 'research', 'seen.json');

/** The result of running (or no-op'ing) one researcher against one request. */
export interface ResearchOutcome {
  requestId: string;
  researcherId: string;
  /** Did the researcher self-nominate (relevance check passed)? */
  nominated: boolean;
  /** Did it actually run (nominated AND under the global ceiling)? */
  ran: boolean;
  /** Secondary-source ids produced (when it ran + found something). */
  sourceIds?: string[];
  /** True when the request hit the chain depth limit and was escalated to Review instead of run. */
  escalated?: boolean;
  /** The depth-limit Review id raised (when `escalated`). */
  reviewId?: string;
  /** Why it didn't run / a one-liner outcome (for the caller's audit). */
  note?: string;
}

export interface DispatchResult {
  /** Requests received. */
  received: number;
  /** Requests that were fresh (not already in the dedup ledger). */
  fresh: number;
  /** Per (fresh request × eligible researcher) outcomes. */
  outcomes: ResearchOutcome[];
  /** True if the global per-dispatch ceiling was reached (further nominations skipped). */
  ceilingHit: boolean;
}

/** The injected cognition seam (substrate-agnostic). */
export interface DispatchDeps {
  /** Cheap relevance check (D3): does `r` think `req` is worth researching? Prod = thin CLI; test = deterministic. */
  selfNominate: (r: ResearcherConfig, req: ResearchRequest) => Promise<boolean>;
  /** Run one nominated research pass → secondary source(s). Owns its own audit + ingest writes. */
  run: (r: ResearcherConfig, req: ResearchRequest) => Promise<{ sourceIds: string[]; note?: string }>;
  /** Raise the depth-limit Review when a chain exceeds `budget.maxDepth` (RESEARCH-11). When omitted,
   *  the over-depth request is still refused (no run) but no Review is written — tests inject a fake. */
  escalate?: (r: ResearcherConfig, req: ResearchRequest, depth: number) => Promise<{ reviewId: string; created: boolean }>;
  /** Max eligible researchers a single request fans out to (RESEARCH-4). Default DEFAULT_MAX_FANOUT. */
  maxFanout?: number;
  /** Hard backstop on total RUNS across this whole dispatch (RESEARCH-11). Default RESEARCH_GLOBAL_CEILING. */
  globalCeiling?: number;
}

async function readSeen(root: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(path.resolve(root), SEEN_REL), 'utf8')) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function writeSeen(root: string, seen: Set<string>): Promise<void> {
  const p = path.join(path.resolve(root), SEEN_REL);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify([...seen]) + '\n', 'utf8');
}

/**
 * Route a batch of research-requests to eligible researchers (RESEARCH-4). Deterministic + bounded:
 * dedup ledger (D2) → eligibility pre-filter + fan-out cap (D3) → self-nomination → run, under the
 * global ceiling (RESEARCH-11). Self-nomination decisions are memoized per (researcher, dedupKey)
 * within the call so the same (researcher, topic) isn't paid for twice in one dispatch. Returns a
 * summary; persists newly-seen request keys so a later dispatch won't re-fan them.
 */
export async function dispatchResearch(
  root: string,
  requests: readonly ResearchRequest[],
  researchers: readonly ResearcherConfig[],
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const maxFanout = deps.maxFanout ?? DEFAULT_MAX_FANOUT;
  const ceiling = deps.globalCeiling ?? RESEARCH_GLOBAL_CEILING;
  const seen = await readSeen(root);
  const nominationMemo = new Map<string, Promise<boolean>>(); // key: researcherId + '' + dedupKey

  const outcomes: ResearchOutcome[] = [];
  let fresh = 0;
  let runs = 0;
  let ceilingHit = false;

  for (const req of requests) {
    if (seen.has(req.dedupKey)) continue; // D2: already routed — coalesce
    seen.add(req.dedupKey);
    fresh++;

    const eligible = researchers.filter((r) => isEligible(r, req)).slice(0, maxFanout);
    for (const r of eligible) {
      const memoKey = `${r.id}${req.dedupKey}`;
      let nominated = nominationMemo.get(memoKey);
      if (nominated === undefined) {
        nominated = deps.selfNominate(r, req);
        nominationMemo.set(memoKey, nominated);
      }
      const didNominate = await nominated;
      if (!didNominate) {
        outcomes.push({ requestId: req.id, researcherId: r.id, nominated: false, ran: false, note: 'not relevant (self-nomination declined)' });
        continue;
      }
      // Depth limit (RESEARCH-11): a research→finding→request chain past the researcher's maxDepth is
      // refused (no egress) and escalated to Review — checked BEFORE the ceiling so an over-depth chain
      // surfaces to the Principal as "continue?" rather than being silently swallowed by the backstop.
      const depth = req.depth ?? 1;
      if (depth > r.budget.maxDepth) {
        let reviewId: string | undefined;
        if (deps.escalate) reviewId = (await deps.escalate(r, req, depth)).reviewId;
        outcomes.push({ requestId: req.id, researcherId: r.id, nominated: true, ran: false, escalated: true, ...(reviewId ? { reviewId } : {}), note: `depth ${depth} > maxDepth ${r.budget.maxDepth} → escalated to Review` });
        continue;
      }
      if (runs >= ceiling) {
        ceilingHit = true;
        outcomes.push({ requestId: req.id, researcherId: r.id, nominated: true, ran: false, note: 'global research ceiling reached' });
        continue;
      }
      runs++;
      const { sourceIds, note } = await deps.run(r, req);
      outcomes.push({ requestId: req.id, researcherId: r.id, nominated: true, ran: true, sourceIds, ...(note ? { note } : {}) });
    }
  }

  if (fresh > 0) await writeSeen(root, seen);
  return { received: requests.length, fresh, outcomes, ceilingHit };
}
