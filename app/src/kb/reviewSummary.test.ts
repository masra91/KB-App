// ENG-15/16 — the Review → ReviewSummary fold must tolerate partial/legacy/malformed reviews without
// throwing (a single bad item must never strand the whole "needs you" queue — the #302 class).
import { describe, it, expect } from 'vitest';
import { reviewToSummary } from './reviewSummary';
import type { Review } from './reviews';

const base = (over: Partial<Review> = {}): Review =>
  ({
    id: 'R1',
    status: 'open',
    question: 'Are these the same person?',
    detail: 'context',
    raisedBy: { stage: 'connect', runId: 'N1', item: { kind: 'entity', ref: 'e' }, auditRel: 'a', markerKey: {} },
    subject: { refs: ['Ada Lovelace'] },
    createdAt: '2026-06-13T00:00:00.000Z',
    ...over,
  }) as Review;

describe('reviewToSummary (REVIEW-10/11 fold; ENG-16)', () => {
  it('maps a well-formed review to the flat summary shape', () => {
    expect(reviewToSummary(base())).toEqual({
      id: 'R1',
      question: 'Are these the same person?',
      detail: 'context',
      stage: 'connect',
      refs: ['Ada Lovelace'],
      createdAt: '2026-06-13T00:00:00.000Z',
    });
  });

  it('carries REVIEW-16 candidates through when present, omits the key when absent/empty', () => {
    const cands = [{ name: 'Ada', gloss: 'the mathematician', title: 'Ada Lovelace notes' }];
    expect(reviewToSummary(base({ subject: { refs: [], candidates: cands } }))).toMatchObject({ candidates: cands });
    expect('candidates' in reviewToSummary(base({ subject: { refs: [], candidates: [] } }))).toBe(false);
  });

  it('an EMPTY subject (CONNECT-15 link review, #110) yields refs:[] — never throws', () => {
    const r = base({ subject: {} });
    expect(() => reviewToSummary(r)).not.toThrow();
    expect(reviewToSummary(r).refs).toEqual([]);
  });

  it('a legacy/malformed review missing subject + raisedBy renders neutral — never throws (the #302 class)', () => {
    // A partial item that slipped past the typed contract (cast through unknown to model the bad shape).
    const malformed = { id: 'OLD', question: 'q', detail: 'd', createdAt: 't' } as unknown as Review;
    expect(() => reviewToSummary(malformed)).not.toThrow();
    expect(reviewToSummary(malformed)).toEqual({ id: 'OLD', question: 'q', detail: 'd', stage: '', refs: [], createdAt: 't' });
  });
});
