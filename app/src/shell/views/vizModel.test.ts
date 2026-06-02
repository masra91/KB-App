// SPEC-0032 VIZ pure view-model (node tier). The maths the renderer draws from — stepper fill,
// directional funnel deltas, carriage virtualization — verified without a DOM.
import { describe, it, expect } from 'vitest';
import { stepperCells, funnelSegments, splitCarriages, STAGE_ORDER, type Conversion, type InFlightItem } from './vizModel';

describe('stepperCells (VIZ-2 — carriage fill)', () => {
  it('fills done before the current stage, current at it, pending after', () => {
    expect(stepperCells('connect')).toEqual(['done', 'done', 'done', 'current', 'pending', 'pending']);
    // capture(0) archive(1) decompose(2) connect(3) claims(4) promote(5)
  });
  it('handles the first and last stations', () => {
    expect(stepperCells('capture')).toEqual(['current', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(stepperCells('promote')).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  });
  it('has one cell per station', () => {
    expect(stepperCells('claims')).toHaveLength(STAGE_ORDER.length);
  });
});

describe('funnelSegments (VIZ-3 — directional deltas)', () => {
  const C: Conversion = { captured: 10, candidates: 10, entities: 7, claims: 22, promoted: 5 };

  it('reads a reduction as "−N deduped" (candidates→entities dedup)', () => {
    const seg = funnelSegments(C).find((s) => s.from === 'candidates' && s.to === 'entities')!;
    expect(seg.direction).toBe('reduce');
    expect(seg.caption).toBe('−3 deduped');
  });

  it('reads a fan-out as "+N (×ratio)" (entities→claims), never a negative', () => {
    const seg = funnelSegments(C).find((s) => s.from === 'entities' && s.to === 'claims')!;
    expect(seg.direction).toBe('expand');
    expect(seg.caption).toBe('+15 (×3.1)'); // 22/7 ≈ 3.14 → 3.1
    expect(seg.caption).not.toContain('−');
  });

  it('reads equal counts as a flat arrow', () => {
    const seg = funnelSegments(C).find((s) => s.from === 'captured' && s.to === 'candidates')!;
    expect(seg.direction).toBe('flat');
    expect(seg.caption).toBe('→');
  });

  it('never divides by zero (expand from 0 → no ×ratio)', () => {
    const seg = funnelSegments({ captured: 0, candidates: 4, entities: 4, claims: 4, promoted: 4 })[0];
    expect(seg.caption).toBe('+4'); // no ×∞
  });

  it('produces one segment per adjacent funnel pair (5 points → 4 segments)', () => {
    expect(funnelSegments(C)).toHaveLength(4);
  });
});

describe('splitCarriages (VIZ-9 — virtualize beyond 12)', () => {
  const mk = (n: number): InFlightItem[] =>
    Array.from({ length: n }, (_v, i) => ({ itemId: `i${i}`, name: `n${i}`, stage: 'claims' as const, sinceTs: 't' }));

  it('shows all when within the cap', () => {
    expect(splitCarriages(mk(5))).toEqual({ visible: expect.any(Array), overflow: 0 });
    expect(splitCarriages(mk(5)).visible).toHaveLength(5);
  });
  it('caps the visible list and reports the overflow ("+K more")', () => {
    const s = splitCarriages(mk(20));
    expect(s.visible).toHaveLength(12);
    expect(s.overflow).toBe(8);
  });
});
