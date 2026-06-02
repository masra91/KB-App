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
import { dispatchResearch, type DispatchDeps, type DispatchResult } from './researchDispatcher';
import { makeCliSelfNominate, type NominateRunner } from './researchNominate';
import { makeWebResearchFn, type WebResearchOptions } from './researchWebAgent';
import { runResearcher, type ResearchFn } from './researchRun';
import type { ResearchRequest } from './researchers';

export interface ResearchDepsOptions {
  /** Thin-CLI relevance runtime for self-nomination (omit → deterministic heuristic only). */
  nominateRunner?: NominateRunner;
  /** Web SDK options (model + injectable session). Omit `session` → live SDK (CI/e2e). */
  web?: WebResearchOptions;
  /** Override the research cognition entirely (tests / future non-Web templates). Defaults to Web. */
  researchFn?: ResearchFn;
  maxFanout?: number;
  globalCeiling?: number;
}

/**
 * Build the dispatcher's `DispatchDeps` from the production cognition (RESEARCH-4): self-nomination =
 * CLI-refined heuristic; run = the per-pass research that writes a cited secondary source + audit.
 * `run` is bound to `root` so a nominated researcher's finding lands in this vault. Web is the v1
 * cognition (RESEARCH-16); Slices 2/3 add Code/M365 behind the same `researchFn` seam.
 */
export function makeResearchDeps(root: string, opts: ResearchDepsOptions = {}): DispatchDeps {
  const research = opts.researchFn ?? makeWebResearchFn(opts.web);
  return {
    selfNominate: makeCliSelfNominate(opts.nominateRunner),
    run: (r, req) => runResearcher(root, r, req, { research }),
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
