// Resume-on-confirm for a depth-limit escalation Review (SPEC-0028 RESEARCH-11, D7 fast-follow).
//
// The depth limit escalates a runaway research→finding→`research-request` chain to a gated yes/no
// Review ("Continue researching X?") instead of egressing further (researchEscalate.ts). That Review
// is a real, actionable control in the Reviews view — so confirming it must actually CONTINUE the
// chain, else it's a dead affordance (the UI bar we hold). On **confirm**, this re-dispatches the
// parked request exactly ONE level deeper: it calls `runResearcher` DIRECTLY (the depth gate lives in
// the dispatcher, so a direct call bypasses it by design) — still bounded by the per-Instance ceiling
// + the per-pass calls budget. On **reject**, nothing runs: the chain stops, which is the safe default.
//
// Self-gating like `executeApprovedConsolidation`: it's safe to call for EVERY answered review — a
// no-op for anything that isn't a confirmed `research-depth` review — so the pipeline wires it in
// unconditionally after an answer (REVIEW-6).
import { getReview } from './reviewStore';
import { readResearcherRegistry } from './researcherRegistry';
import { runResearcher, type RunResearcherDeps } from './researchRun';
import { selectResearchFn, type ResearchDepsOptions } from './researchInline';
import { RESEARCH_DEPTH_REVIEW_KIND } from './researchEscalate';
import { dedupKeyFor, type ResearchRequest } from './researchers';

export interface ResearchResumeResult {
  /** True when a confirmed depth-escalation actually re-ran one level deeper. */
  resumed: boolean;
  /** Secondary-source ids the resumed pass produced (when it ran + found something). */
  sourceIds?: string[];
  /** Why it was a no-op (for the caller's log), when not resumed. */
  reason?: 'not-a-research-review' | 'not-confirmed' | 'unanswered' | 'researcher-missing' | 'not-found';
}

/**
 * If review `reviewId` is a CONFIRMED `research-depth` escalation, re-dispatch its parked request one
 * level deeper and return the pass result; otherwise a safe no-op (so it can be called for every
 * answered review). Reconstructs the request from the review's markerKey (stored at escalation time),
 * loads the researcher from the registry, and runs `runResearcher` directly (bypassing the dispatcher's
 * depth gate by design — the Principal authorized this one deeper pass — while still honoring the
 * per-Instance ceiling). A finding that spawns a yet-deeper request re-escalates, so the chain stays
 * Principal-gated at every level. `opts` supplies the cognition (cliPath/dev-log/test override).
 */
export async function resumeApprovedResearchEscalation(
  root: string,
  reviewId: string,
  opts: ResearchDepsOptions = {},
  runDeps: Omit<RunResearcherDeps, 'research'> = {},
): Promise<ResearchResumeResult> {
  const review = await getReview(root, reviewId);
  if (!review) return { resumed: false, reason: 'not-found' };
  const mk = review.raisedBy.markerKey;
  if (mk.kind !== RESEARCH_DEPTH_REVIEW_KIND) return { resumed: false, reason: 'not-a-research-review' };
  if (review.status !== 'answered' || !review.answer) return { resumed: false, reason: 'unanswered' };
  if (review.answer.verdict !== 'confirm') return { resumed: false, reason: 'not-confirmed' }; // reject → chain stops

  const researcher = (await readResearcherRegistry(root)).find((r) => r.id === mk.researcherId);
  if (!researcher) return { resumed: false, reason: 'researcher-missing' };

  // Reconstruct the original request from the marker. `id` MUST stay the original requestId so the
  // resumed pass's `researched` audit links into the same chain lineage (depth stays consistent).
  const what = mk.what ?? '';
  const by: ResearchRequest['by'] = { stage: 'review-resume', ...(mk.sourceId ? { sourceId: mk.sourceId } : {}), ...(mk.entityId ? { entityId: mk.entityId } : {}) };
  const req: ResearchRequest = {
    id: mk.requestId,
    ts: review.answer.answeredAt,
    by,
    what,
    why: mk.why ?? '',
    context: mk.context ?? '',
    dedupKey: mk.dedupKey ?? dedupKeyFor({ what, by }),
  };

  const research = selectResearchFn(root, researcher, opts);
  const res = await runResearcher(root, researcher, req, { research, ...runDeps });
  return { resumed: true, sourceIds: res.sourceIds };
}
