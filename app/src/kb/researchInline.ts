// Inline research wiring (SPEC-0028 RESEARCH-2/3/4) — ties the cognition modules to the deterministic
// dispatcher. `makeResearchDeps` bundles the production self-nomination (thin CLI + heuristic) and the
// Web run-pass (SDK adapter behind the seam) into the dispatcher's `DispatchDeps`; `runInlineResearch`
// loads the enabled researchers and dispatches a batch of `research-request`s through them.
//
// Both cognition paths are injected (NominateRunner / WebResearchOptions.session), so this wiring is
// unit-testable end-to-end with fakes — no network — and production swaps in the live CLI + SDK.
// Egress + untrusted-content gates live in the modules this composes (researchWebAgent), enforced
// regardless of how dispatch is triggered.
import { readResearcherRegistry } from './researcherRegistry';
import { readEvents } from './activityIndex';
import { dispatchResearch, type DispatchDeps, type DispatchResult } from './researchDispatcher';
import { makeCliSelfNominate, type NominateRunner } from './researchNominate';
import { makeWebResearchFn, type WebResearchOptions } from './researchWebAgent';
import { makeCodeResearchFn, type CodeResearchOptions } from './researchCodeAgent';
import { runResearcher, type ResearchFn } from './researchRun';
import { RESEARCH_REQUEST_SIGNAL, dedupKeyFor, type ResearcherConfig, type ResearchRequest } from './researchers';

export interface ResearchDepsOptions {
  /** Thin-CLI relevance runtime for self-nomination (omit → deterministic heuristic only). */
  nominateRunner?: NominateRunner;
  /** Web SDK options (model + injectable session). Omit `session` → live SDK (CI/e2e). */
  web?: WebResearchOptions;
  /** Code researcher options (read-only git layer pass-through). */
  code?: CodeResearchOptions;
  /** Override the research cognition for EVERY researcher (tests). Wins over per-template selection. */
  researchFn?: ResearchFn;
  maxFanout?: number;
  globalCeiling?: number;
}

/** A no-op cognition for templates whose behavior hasn't landed yet (m365/custom in Slice 2) — a
 *  graceful no-finding, never an error, so an enabled-but-unimplemented researcher just does nothing. */
const noResearchFn: ResearchFn = async (_r, req) => ({ found: false, note: '', citations: [], query: req.what });

/**
 * Select the cognition for ONE researcher by its template (RESEARCH-16) — the seam where Web/Code/M365
 * diverge. An explicit `opts.researchFn` (tests) overrides all templates. Bound to `root` so a code
 * researcher's sandbox + a web finding both land in this vault.
 */
export function selectResearchFn(root: string, r: ResearcherConfig, opts: ResearchDepsOptions = {}): ResearchFn {
  if (opts.researchFn) return opts.researchFn;
  switch (r.template) {
    case 'web':
      return makeWebResearchFn(opts.web);
    case 'code':
      return makeCodeResearchFn(root, opts.code);
    default:
      return noResearchFn; // m365 (Slice 3) / custom — not yet implemented
  }
}

/**
 * Build the dispatcher's `DispatchDeps` from the production cognition (RESEARCH-4): self-nomination =
 * CLI-refined heuristic; run = the per-pass research that writes a cited secondary source + audit.
 * `run` is bound to `root` and selects the cognition PER-RESEARCHER by template (Web/Code), so a
 * mixed registry routes each researcher to its own runtime behind the one `ResearchFn` seam.
 */
export function makeResearchDeps(root: string, opts: ResearchDepsOptions = {}): DispatchDeps {
  return {
    selfNominate: makeCliSelfNominate(opts.nominateRunner),
    run: (r, req) => runResearcher(root, r, req, { research: selectResearchFn(root, r, opts) }),
    ...(opts.maxFanout !== undefined ? { maxFanout: opts.maxFanout } : {}),
    ...(opts.globalCeiling !== undefined ? { globalCeiling: opts.globalCeiling } : {}),
  };
}

/**
 * Run a batch of inline `research-request`s (RESEARCH-2/3): load the enabled researchers and route the
 * requests through the deterministic dispatcher (dedup → eligibility → self-nomination → bounded run).
 * Disabled researchers are skipped (the registry holds enabled+disabled; only enabled research).
 * Returns the dispatch summary for the caller to audit/journal.
 */
export async function runInlineResearch(root: string, requests: readonly ResearchRequest[], opts: ResearchDepsOptions = {}): Promise<DispatchResult> {
  const researchers = (await readResearcherRegistry(root)).filter((r) => r.enabled);
  return dispatchResearch(root, requests, researchers, makeResearchDeps(root, opts));
}

/**
 * Collect the `research-request` signals a producer emitted (RESEARCH-3, D1) from the audit into
 * `ResearchRequest`s ready for dispatch. A producer (a pipeline stage that hit an unknown term, or
 * Reflect) emits `signals: [{ type: 'research-request', what, why, context?, refs? }]`, which lands
 * as a `signal` audit event whose payload carries those fields. We read them back here; the
 * dispatcher's persistent dedup ledger then ensures the same request isn't fanned out twice across
 * sweeps, so re-collecting old signals is safe + idempotent.
 */
export async function collectResearchRequests(root: string): Promise<ResearchRequest[]> {
  const events = await readEvents(root, {}); // newest-first
  const out: ResearchRequest[] = [];
  for (const e of events) {
    if (e.eventType !== 'signal') continue;
    const p = e.payload;
    if (p.type !== RESEARCH_REQUEST_SIGNAL || typeof p.what !== 'string' || p.what.length === 0) continue;
    const by = {
      stage: e.actor,
      ...(e.subjects.sourceId ? { sourceId: e.subjects.sourceId } : {}),
      ...(e.subjects.entityId ? { entityId: e.subjects.entityId } : {}),
    };
    out.push({
      // Stable id from provenance so re-collecting the same signal yields the same request.
      id: `${e.provenance.file}:${e.provenance.line}`,
      ts: e.ts,
      by,
      what: p.what,
      // The signal's `note` is the *why* (D1); accept an explicit `why` too for forward-compat.
      why: typeof p.why === 'string' ? p.why : typeof p.note === 'string' ? p.note : '',
      context: typeof p.context === 'string' ? p.context : '',
      ...(typeof p.egressHint === 'string' ? { egressHint: p.egressHint as ResearchRequest['egressHint'] } : {}),
      dedupKey: dedupKeyFor({ what: p.what, by }),
    });
  }
  return out;
}

/**
 * One inline-research sweep (RESEARCH-2/3): collect the pending `research-request` signals + route
 * them through the dispatcher. Intended to be poked after a stage drain (where unknown-term signals
 * arise) or on the researcher tick; the dedup ledger makes repeated sweeps cheap. Inert until a
 * producer actually emits `research-request` signals.
 */
export async function runInlineResearchSweep(root: string, opts: ResearchDepsOptions = {}): Promise<DispatchResult> {
  return runInlineResearch(root, await collectResearchRequests(root), opts);
}
