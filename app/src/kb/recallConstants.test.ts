import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RECALL_BUDGET_MS,
  RECALL_BUDGET_MS_MIN,
  RECALL_BUDGET_MS_MAX,
  clampRecallBudgetMs,
  RECALL_BUDGET,
  recallBudget,
  clampRecallMaxToolCalls,
  resolveRecallMaxToolCallsWrite,
} from './recallConstants';

// SPEC-0026 ASK-17/19 — the PURE recall budget constants/clamps. The renderer ("Recall & Ask" card)
// imports these, so they MUST stay node-free (build-check enforces the bundle boundary); the values
// + clamp contracts are pinned here so a raise/regression is caught at the source.

describe('recall time budget (ASK-17) — sane bounds + clamp', () => {
  it('default sits inside the bounds and above the old hard 60s', () => {
    expect(DEFAULT_RECALL_BUDGET_MS).toBe(240_000);
    expect(DEFAULT_RECALL_BUDGET_MS).toBeGreaterThan(60_000);
    expect(RECALL_BUDGET_MS_MIN).toBe(60_000);
    expect(RECALL_BUDGET_MS_MAX).toBe(600_000);
    expect(DEFAULT_RECALL_BUDGET_MS).toBeGreaterThanOrEqual(RECALL_BUDGET_MS_MIN);
    expect(DEFAULT_RECALL_BUDGET_MS).toBeLessThanOrEqual(RECALL_BUDGET_MS_MAX);
  });

  it('clamps to [MIN, MAX]; a non-finite value → default', () => {
    expect(clampRecallBudgetMs(240_000)).toBe(240_000);
    expect(clampRecallBudgetMs(1)).toBe(RECALL_BUDGET_MS_MIN);
    expect(clampRecallBudgetMs(99_999_999)).toBe(RECALL_BUDGET_MS_MAX);
    expect(clampRecallBudgetMs('nope')).toBe(DEFAULT_RECALL_BUDGET_MS);
    expect(clampRecallBudgetMs(undefined)).toBe(DEFAULT_RECALL_BUDGET_MS);
    expect(clampRecallBudgetMs(NaN)).toBe(DEFAULT_RECALL_BUDGET_MS);
  });

  it('the bounds are whole minutes (the card edits in minutes)', () => {
    expect(RECALL_BUDGET_MS_MIN % 60_000).toBe(0);
    expect(RECALL_BUDGET_MS_MAX % 60_000).toBe(0);
    expect(DEFAULT_RECALL_BUDGET_MS % 60_000).toBe(0);
  });
});

describe('recall retrieval tool-call budget (ASK-19) — raised bounds + override clamp', () => {
  it('the raise is pinned: BASE 2→4, MAX 16→24 (regression)', () => {
    expect(RECALL_BUDGET.BASE).toBe(4);
    expect(RECALL_BUDGET.MAX).toBe(24);
    expect(RECALL_BUDGET.MIN).toBe(4);
    expect(RECALL_BUDGET.PER_NODE).toBe(0.5);
  });

  it('recallBudget scales from the raised base and caps at the raised max', () => {
    expect(recallBudget(0)).toBe(4);
    expect(recallBudget(6)).toBe(7); // 4 + ceil(0.5*6)=3
    expect(recallBudget(40)).toBe(24); // 4 + 20 → MAX
    expect(recallBudget(10_000)).toBe(24);
  });

  it('clampRecallMaxToolCalls: a number clamps to [MIN, MAX]; non-finite → undefined (no override)', () => {
    expect(clampRecallMaxToolCalls(12)).toBe(12);
    expect(clampRecallMaxToolCalls(1)).toBe(RECALL_BUDGET.MIN); // below floor → MIN
    expect(clampRecallMaxToolCalls(999)).toBe(RECALL_BUDGET.MAX); // above ceiling → MAX
    expect(clampRecallMaxToolCalls(12.7)).toBe(12); // floored
    expect(clampRecallMaxToolCalls(undefined)).toBeUndefined();
    expect(clampRecallMaxToolCalls('nope')).toBeUndefined();
    expect(clampRecallMaxToolCalls(NaN)).toBeUndefined();
  });

  it('resolveRecallMaxToolCallsWrite: undefined preserves, null clears, a number clamps (the #102 three-state)', () => {
    // undefined PRESERVES the prior (preserve-on-omission — no caller wipes by omission)
    expect(resolveRecallMaxToolCallsWrite(12, undefined)).toBe(12);
    expect(resolveRecallMaxToolCallsWrite(undefined, undefined)).toBeUndefined();
    // null is the Auto toggle's explicit CLEAR back to the scaled default
    expect(resolveRecallMaxToolCallsWrite(12, null)).toBeUndefined();
    // a number sets the clamped override regardless of prior
    expect(resolveRecallMaxToolCallsWrite(undefined, 8)).toBe(8);
    expect(resolveRecallMaxToolCallsWrite(12, 999)).toBe(RECALL_BUDGET.MAX);
  });
});
