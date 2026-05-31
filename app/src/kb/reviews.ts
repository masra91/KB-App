// Review domain types + validation (SPEC-0018 REVIEW). A review is a single YES/NO question
// + context that a thin agent raises (via the decision channel, REVIEW-14) when it must ask
// rather than guess. The orchestrator mints the id and does all effects (ORCH-7).
//
// Two shapes here:
//  - ReviewRequest — what the AGENT emits in its decision (`reviews[]`): question + detail.
//  - Review        — the durable ARTIFACT the orchestrator writes (adds id/provenance/status,
//                    then an answer on resolution). Canonical storage is JSON (a workflow
//                    artifact read by the app, not Obsidian-native knowledge), so no
//                    hand-rolled YAML parser is needed (ENG simplicity).

/** A yes/no verdict from the Principal (REVIEW-2). */
export const REVIEW_VERDICTS = ['confirm', 'reject'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** What the agent emits in its decision to raise a review (REVIEW-1/3/14). */
export interface ReviewRequest {
  /** A single yes/no question — confirmable, never open-ended (REVIEW-2). */
  question: string;
  /** Expandable context: why the agent cares + what a verdict means (REVIEW-3). */
  detail: string;
  /** Optional entity names / mentions the question is about. */
  refs?: string[];
}

/** A reference to the parked work item that raised the review (the resume target). */
export interface ReviewItemRef {
  kind: string; // e.g. 'entity'
  ref: string; // repo-relative path to the item (e.g. entities/2026/05/31/<id>.md)
}

/** The Principal's answer, added when the review is resolved (REVIEW-6/7). */
export interface ReviewAnswer {
  verdict: ReviewVerdict;
  note?: string; // optional free-text; captured as a primary source (REVIEW-7)
  noteSourceId?: string; // ULID of the captured note-source, if a note was added
  answeredAt: string; // ISO timestamp
}

/** The durable review artifact (`reviews/<shard>/<id>/review.json`). */
export interface Review {
  id: string;
  status: 'open' | 'answered';
  question: string;
  detail: string;
  raisedBy: {
    stage: string;
    runId: string;
    item: ReviewItemRef; // the parked item to resume on answer (for the UI / humans)
    auditRel: string; // repo-relative audit.jsonl to append the `review-answered` marker to
    markerKey: Record<string, string>; // fields the stage filters on (e.g. { entityId }) — kept
    // generic so the review store can supersede the park without knowing the stage's internals
  };
  subject: {
    refs?: string[];
    sources?: string[]; // repo-relative source dirs the question concerns
  };
  createdAt: string;
  answer?: ReviewAnswer;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

/** Validate one review request from an agent decision (REVIEW-2/3); throws on a bad shape. */
export function validReviewRequest(v: unknown, i: number): ReviewRequest {
  if (typeof v !== 'object' || v === null) throw new Error(`review: reviews[${i}] must be an object`);
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.question)) throw new Error(`review: reviews[${i}].question must be a non-empty string`);
  if (!isNonEmptyString(o.detail)) throw new Error(`review: reviews[${i}].detail must be a non-empty string`);
  const req: ReviewRequest = { question: o.question, detail: o.detail };
  if (o.refs !== undefined) {
    if (!Array.isArray(o.refs) || !o.refs.every(isNonEmptyString)) {
      throw new Error(`review: reviews[${i}].refs must be an array of non-empty strings`);
    }
    if (o.refs.length > 0) req.refs = o.refs as string[];
  }
  return req;
}

/** Validate a `reviews[]` array from a decision (optional channel). Returns [] when absent. */
export function validReviewRequests(v: unknown): ReviewRequest[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('review: reviews must be an array when present');
  return v.map((r, i) => validReviewRequest(r, i));
}

/** Parse an answer payload coming from the UI/IPC (REVIEW-2); throws on a bad shape. */
export function validReviewAnswerInput(v: unknown): { verdict: ReviewVerdict; note?: string } {
  if (typeof v !== 'object' || v === null) throw new Error('review: answer must be an object');
  const o = v as Record<string, unknown>;
  if (!isReviewVerdict(o.verdict)) {
    throw new Error(`review: verdict must be one of ${REVIEW_VERDICTS.join('|')}, got ${JSON.stringify(o.verdict)}`);
  }
  const out: { verdict: ReviewVerdict; note?: string } = { verdict: o.verdict };
  if (o.note !== undefined) {
    if (typeof o.note !== 'string') throw new Error('review: note must be a string when present');
    if (o.note.trim().length > 0) out.note = o.note;
  }
  return out;
}
