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
