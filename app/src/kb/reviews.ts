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

/**
 * A per-candidate distinguishing gloss the RAISING agent authors for a disambiguation review
 * (REVIEW-16). Keyed by candidate `id` — in a "same entity?" review the candidates usually share
 * a NAME, so a name key would be ambiguous; the id ties the gloss to the right one. The stage
 * enriches `{id}` → `{name, sourceRel}` from the candidate set (the agent only authors the gloss).
 */
export interface ReviewCandidateGloss {
  /** The candidate id from the agent's input set (e.g. a Connect `Candidate.id`). */
  id: string;
  /** A one-line "what makes this one this one" — source context / strongest claim / timeframe. */
  gloss: string;
}

/** What the agent emits in its decision to raise a review (REVIEW-1/3/14). */
export interface ReviewRequest {
  /** A single yes/no question — confirmable, never open-ended (REVIEW-2). */
  question: string;
  /** Expandable context: why the agent cares + what a verdict means (REVIEW-3). */
  detail: string;
  /** Optional entity names / mentions the question is about. */
  refs?: string[];
  /**
   * Optional decision-grade per-candidate context for a disambiguation review (REVIEW-16): each
   * affected candidate's id + a distinguishing gloss the agent authored. The stage joins these to
   * `subject.candidates` ({name, sourceRel, gloss}); the `question` itself should use the glosses.
   */
  candidates?: ReviewCandidateGloss[];
}

/** Decision-grade per-candidate context on a persisted review (REVIEW-16), rendered as a row. */
export interface ReviewSubjectCandidate {
  /** The candidate's surface name. */
  name: string;
  /** The distinguishing gloss authored by the raising agent (what makes this one this one). */
  gloss: string;
  /**
   * The source's human-readable TITLE, resolved + persisted at raise time (PRIN-24): the view shows
   * this (e.g. as the link text) — NEVER the raw ULID. Always populated for a stage-built candidate
   * (falls back to the candidate `name` if the source has no derivable title). Persisted at raise so
   * the display is durable + offline (no per-render IPC) and immune to source promotion-lag.
   */
  title: string;
  /**
   * Repo-relative source FILE (`<dir>/source.md`) → the working "Open in Obsidian" link (REVIEW-16):
   * the readable note, not the bare dir (opening a dir is "file not found", PRIN-24). Omitted if unknown.
   */
  sourceRel?: string;
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
    candidates?: ReviewSubjectCandidate[]; // REVIEW-16: decision-grade per-candidate context + links
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
  if (o.candidates !== undefined) {
    if (!Array.isArray(o.candidates)) {
      throw new Error(`review: reviews[${i}].candidates must be an array when present`);
    }
    const cands = o.candidates.map((c, j): ReviewCandidateGloss => {
      if (typeof c !== 'object' || c === null) throw new Error(`review: reviews[${i}].candidates[${j}] must be an object`);
      const co = c as Record<string, unknown>;
      if (!isNonEmptyString(co.id)) throw new Error(`review: reviews[${i}].candidates[${j}].id must be a non-empty string`);
      if (!isNonEmptyString(co.gloss)) throw new Error(`review: reviews[${i}].candidates[${j}].gloss must be a non-empty string`);
      return { id: co.id, gloss: co.gloss };
    });
    if (cands.length > 0) req.candidates = cands;
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
