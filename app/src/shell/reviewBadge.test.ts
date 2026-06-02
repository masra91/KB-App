// SPEC-0027 PANEL-8 — review-count badge text/label logic. Node tier (pure; DOM wiring is in shell.ts).
import { describe, it, expect } from 'vitest';
import { reviewBadgeText, reviewBadgeAria } from './reviewBadge';

describe('reviewBadgeText (PANEL-8)', () => {
  it('is empty for zero / negative / non-finite counts', () => {
    expect(reviewBadgeText(0)).toBe('');
    expect(reviewBadgeText(-1)).toBe('');
    expect(reviewBadgeText(NaN)).toBe('');
  });
  it('shows the count, capped at 99+', () => {
    expect(reviewBadgeText(1)).toBe('1');
    expect(reviewBadgeText(42)).toBe('42');
    expect(reviewBadgeText(99)).toBe('99');
    expect(reviewBadgeText(100)).toBe('99+');
  });
});

describe('reviewBadgeAria (PANEL-8)', () => {
  it('is empty when nothing needs you', () => {
    expect(reviewBadgeAria(0)).toBe('');
  });
  it('reads naturally, singular vs plural', () => {
    expect(reviewBadgeAria(1)).toBe('1 review needs your attention');
    expect(reviewBadgeAria(3)).toBe('3 reviews need your attention');
  });
});
