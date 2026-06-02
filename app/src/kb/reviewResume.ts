// Resume-routing for answered Reviews (REVIEW-6): which stage to re-poke so a parked item resumes
// PROMPTLY. Pure + shell-agnostic so it's unit-testable; `pipeline.answerActiveReview` consumes it.
//
// The bug it fixes (#46): only `claims` was routed, so an answered **ambiguous-link Review**
// (CONNECT-15, raised by the `connect` stage) was never re-poked — its confirmed `[[wikilink]]`
// (or reject note) only rendered on Connect's ≤30s sweep backstop instead of immediately.

/** The stage to re-poke for an answered review of `stage`, or `null` if none applies. */
export function reviewResumeStage(stage: string | undefined): 'claims' | 'connect' | null {
  if (stage === 'claims') return 'claims';
  if (stage === 'connect') return 'connect'; // CONNECT-15 ambiguous-link review (#46)
  return null;
}
