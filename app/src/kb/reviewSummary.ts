// The pure Review → ReviewSummary projection (SPEC-0018 REVIEW-10/11). Folds a stored `Review` into
// the flat, view-facing shape the "needs you" queue + the rail badge render. Pure + DOM-free so it's
// unit-tested in the node tier; the main process's review projection (SHELL-12 `reviewStore`) maps
// each open review through it.
//
// ENG-16: a review's `subject` is OPTIONAL-shaped per review type — a CONNECT-15 link review has an
// EMPTY subject (#110: no entity subject, just a node↔target link), and a legacy/partial review may be
// missing it entirely. Every access is optional-chained + defaulted so a malformed item can never
// throw here and blank the whole queue (the #302 class — one bad item must not strand the surface).
import type { Review } from './reviews';
import type { ReviewSummary } from './types';

export function reviewToSummary(r: Review): ReviewSummary {
  return {
    id: r.id,
    question: r.question,
    detail: r.detail,
    stage: r.raisedBy?.stage ?? '',
    refs: r.subject?.refs ?? [],
    // REVIEW-16: carry the per-candidate disambiguation context through to the view (rows + links +
    // each candidate's resolved source title, persisted at raise — PRIN-24). Omitted when there are none.
    ...(r.subject?.candidates?.length ? { candidates: r.subject.candidates } : {}),
    createdAt: r.createdAt,
  };
}
