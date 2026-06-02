// Research depth-limit escalation (SPEC-0028 RESEARCH-11) — when a research→finding→`research-request`
// chain reaches a researcher's `budget.maxDepth`, the dispatcher does NOT run another pass (no further
// egress); instead it raises a single yes/no Review ("continue researching X?") so the Principal
// decides whether to go deeper. This is the deterministic hard stop on chain runaway, the analogue of
// the per-pass fetch cap (#154) one level up — enforced by the router, never prompt-advisory.
//
// Mirrors the JOBS Review pattern (jobStage.ts): mint a ULID, write the durable `Review` artifact via
// the shared review store, and audit the escalation. Idempotent per request: a chain that re-surfaces
// the same over-depth request across sweeps reuses its existing OPEN review rather than piling up
// duplicates (keyed by `markerKey.kind + requestId`).
import path from 'node:path';
import { ulid } from './ulid';
import { reviewRel, writeReviewFile, readAllReviews } from './reviewStore';
import { appendAuditEvent, CONTROL_AUDIT_REL } from './audit';
import type { Review } from './reviews';
import type { ResearcherConfig, ResearchRequest } from './researchers';

/** Marker that identifies a depth-limit review, so it's idempotent + a future resume can find it. */
export const RESEARCH_DEPTH_REVIEW_KIND = 'research-depth';

export interface ResearchEscalationResult {
  reviewId: string;
  /** False when an open review for this request already existed (coalesced — no new artifact/audit). */
  created: boolean;
}

/**
 * Raise (or reuse) the depth-limit Review for `req` at `depth` (RESEARCH-11). Returns the review id.
 * Idempotent: if an OPEN `research-depth` review already exists for this `requestId`, it is reused and
 * nothing is written — so repeated sweeps of the same over-depth chain don't spawn duplicate reviews.
 * Writes the artifact + a `researcher`/`escalated` audit event (no secondary source, no egress).
 */
export async function raiseResearchEscalation(
  root: string,
  r: ResearcherConfig,
  req: ResearchRequest,
  depth: number,
  now: () => string = () => new Date().toISOString(),
): Promise<ResearchEscalationResult> {
  const existing = (await readAllReviews(root)).find(
    (rev) => rev.status === 'open' && rev.raisedBy.markerKey.kind === RESEARCH_DEPTH_REVIEW_KIND && rev.raisedBy.markerKey.requestId === req.id,
  );
  if (existing) return { reviewId: existing.id, created: false };

  const ts = now();
  const id = ulid(Date.parse(ts) || Date.now());
  const who = r.label ?? r.id;
  const review: Review = {
    id,
    status: 'open',
    question: `Continue researching “${req.what}”?`,
    detail:
      `The research chain for “${req.what}” reached depth ${depth} (limit ${r.budget.maxDepth}). ` +
      `Researcher “${who}” wants to go one level deeper (research → finding → new research-request). ` +
      `Confirm to allow another pass; reject to stop the chain here. Why this term: ${req.why || '(none given)'}.`,
    raisedBy: {
      stage: 'researcher',
      runId: id,
      // The parked item is the request itself (no canonical file — it's an audit signal); ref carries
      // its stable id so a resume consumer / the UI can identify the chain.
      item: { kind: 'research-request', ref: req.id },
      auditRel: CONTROL_AUDIT_REL, // where answerReview appends the `review-answered` resume marker
      // markerKey carries everything resume-on-confirm needs to reconstruct + re-dispatch the request
      // one level deeper WITHOUT re-reading the audit (what/why/context/dedupKey + the subject ids).
      // markerKey values are strings (Review contract).
      markerKey: {
        kind: RESEARCH_DEPTH_REVIEW_KIND,
        requestId: req.id,
        researcherId: r.id,
        depth: String(depth),
        maxDepth: String(r.budget.maxDepth),
        what: req.what,
        why: req.why,
        context: req.context,
        dedupKey: req.dedupKey,
        ...(req.by.sourceId ? { sourceId: req.by.sourceId } : {}),
        ...(req.by.entityId ? { entityId: req.by.entityId } : {}),
      },
    },
    subject: { refs: [req.what] },
    createdAt: ts,
  };
  await writeReviewFile(path.join(path.resolve(root), reviewRel(id)), review);

  await appendAuditEvent(root, {
    actor: 'researcher',
    eventType: 'escalated',
    ts,
    subjects: { researcherId: r.id, requestId: req.id, reviewId: id, ...(req.by.entityId ? { entityId: req.by.entityId } : {}), ...(req.by.sourceId ? { sourceId: req.by.sourceId } : {}) },
    payload: { what: req.what, why: req.why, depth, maxDepth: r.budget.maxDepth, egressTier: r.egressTier, escalatedToReview: true },
  });

  return { reviewId: id, created: true };
}
