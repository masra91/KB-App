// Review validation (SPEC-0018 REVIEW-2/3). Pure — no FS/git.
import { describe, it, expect } from 'vitest';
import { validReviewRequest, validReviewRequests, validReviewAnswerInput, isReviewVerdict, REVIEW_VERDICTS } from './reviews';

describe('validReviewRequest (REVIEW-2/3)', () => {
  it('accepts a question + detail (+ optional refs)', () => {
    const r = validReviewRequest({ question: 'Is this Steve, Steve Jones?', detail: 'why it matters', refs: ['Steve'] }, 0);
    expect(r).toEqual({ question: 'Is this Steve, Steve Jones?', detail: 'why it matters', refs: ['Steve'] });
  });
  it('drops empty refs to undefined', () => {
    expect(validReviewRequest({ question: 'q', detail: 'd', refs: [] }, 0).refs).toBeUndefined();
  });
  it('requires a non-empty question (REVIEW-2)', () => {
    expect(() => validReviewRequest({ question: '', detail: 'd' }, 0)).toThrow(/question/);
  });
  it('requires non-empty detail/context (REVIEW-3)', () => {
    expect(() => validReviewRequest({ question: 'q' }, 0)).toThrow(/detail/);
  });

  // REVIEW-16: a disambiguation review may carry per-candidate distinguishing glosses (id-keyed).
  it('accepts candidates[] of {id, gloss} (REVIEW-16)', () => {
    const r = validReviewRequest(
      { question: 'Is Steve (fishing notes) the same as Steve (wedding list)?', detail: 'd', candidates: [{ id: '01A', gloss: 'from the fishing-trip notes' }, { id: '01B', gloss: "Dave's wedding guest list" }] },
      0,
    );
    expect(r.candidates).toEqual([{ id: '01A', gloss: 'from the fishing-trip notes' }, { id: '01B', gloss: "Dave's wedding guest list" }]);
  });
  it('drops empty candidates[] to undefined (REVIEW-16)', () => {
    expect(validReviewRequest({ question: 'q', detail: 'd', candidates: [] }, 0).candidates).toBeUndefined();
  });
  it('requires each candidate to carry a non-empty id AND gloss (REVIEW-16)', () => {
    expect(() => validReviewRequest({ question: 'q', detail: 'd', candidates: [{ gloss: 'g' }] }, 0)).toThrow(/candidates\[0\]\.id/);
    expect(() => validReviewRequest({ question: 'q', detail: 'd', candidates: [{ id: '01A' }] }, 0)).toThrow(/candidates\[0\]\.gloss/);
    expect(() => validReviewRequest({ question: 'q', detail: 'd', candidates: {} }, 0)).toThrow(/candidates must be an array/);
  });
  it('accepts an optional 2-tuple `pair` of distinct entity ids (REVIEW-18 / CONNECT-21)', () => {
    expect(validReviewRequest({ question: 'q', detail: 'd', pair: ['01A', '01B'] }, 0).pair).toEqual(['01A', '01B']);
    expect(validReviewRequest({ question: 'q', detail: 'd' }, 0).pair).toBeUndefined();
    expect(() => validReviewRequest({ question: 'q', detail: 'd', pair: ['01A'] }, 0)).toThrow(/pair must be a 2-tuple/);
    expect(() => validReviewRequest({ question: 'q', detail: 'd', pair: ['01A', ''] }, 0)).toThrow(/pair must be a 2-tuple/);
    expect(() => validReviewRequest({ question: 'q', detail: 'd', pair: ['01A', '01A'] }, 0)).toThrow(/two DISTINCT/);
  });
});

describe('validReviewRequests (the optional decision channel)', () => {
  it('returns [] when absent', () => {
    expect(validReviewRequests(undefined)).toEqual([]);
  });
  it('throws when not an array', () => {
    expect(() => validReviewRequests({})).toThrow(/must be an array/);
  });
});

describe('validReviewAnswerInput (REVIEW-2)', () => {
  it('accepts confirm/reject', () => {
    expect(validReviewAnswerInput({ verdict: 'confirm' })).toEqual({ verdict: 'confirm' });
    expect(validReviewAnswerInput({ verdict: 'reject', note: "it's Steve Lin" })).toEqual({ verdict: 'reject', note: "it's Steve Lin" });
  });
  it('drops a blank note', () => {
    expect(validReviewAnswerInput({ verdict: 'confirm', note: '   ' }).note).toBeUndefined();
  });
  it('rejects a non-boolean verdict (REVIEW-2: yes/no only)', () => {
    expect(() => validReviewAnswerInput({ verdict: 'maybe' })).toThrow(/verdict must be one of/);
  });
  it('isReviewVerdict guards the closed set', () => {
    expect(REVIEW_VERDICTS.every(isReviewVerdict)).toBe(true);
    expect(isReviewVerdict('nope')).toBe(false);
  });
});
