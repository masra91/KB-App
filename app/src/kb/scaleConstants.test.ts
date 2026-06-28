// SPEC-0048 SCALE — the PURE stage-parallelism constants/clamps (no node import, so the renderer can
// consume them). The persisted read/clamp is covered in instanceConfig.test.ts; here we pin the pure
// contract directly, including the Settings edit's three-way ceiling-write intent (preserve/clear/set).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STAGE_CAPS,
  STAGE_CAP_MAX,
  COPILOT_CEILING_MAX,
  clampStageCap,
  clampCopilotCeiling,
  resolveStageCaps,
  resolveCeilingWrite,
} from './scaleConstants';

describe('DEFAULT_STAGE_CAPS baseline (SCALE adaptive-default — SPEC-0048 batch-2)', () => {
  it('pins the raised per-stage baselines: cap-stages at 4, Connect serial (1) by default', () => {
    expect(DEFAULT_STAGE_CAPS).toEqual({ archive: 4, decompose: 4, connect: 1, claims: 4, compose: 4 });
    // Every default stays within the sane per-stage bound.
    for (const cap of Object.values(DEFAULT_STAGE_CAPS)) expect(cap).toBeLessThanOrEqual(STAGE_CAP_MAX);
  });
});

describe('clampStageCap', () => {
  it('clamps a configured cap into [1, STAGE_CAP_MAX]', () => {
    expect(clampStageCap('decompose', 4)).toBe(4);
    expect(clampStageCap('decompose', 0)).toBe(1);
    expect(clampStageCap('decompose', 999)).toBe(STAGE_CAP_MAX);
    expect(clampStageCap('decompose', 3.7)).toBe(3); // floored
  });
  it('falls back to the stage default for a non-finite value', () => {
    expect(clampStageCap('claims', 'nope' as unknown as number)).toBe(DEFAULT_STAGE_CAPS.claims);
    expect(clampStageCap('compose', Number.NaN)).toBe(DEFAULT_STAGE_CAPS.compose);
  });
  it('clamps Connect like any other stage now (SCALE-5: no longer pinned to 1)', () => {
    expect(clampStageCap('connect', 8)).toBe(8);
    expect(clampStageCap('connect', 999)).toBe(STAGE_CAP_MAX);
    expect(clampStageCap('connect', 0)).toBe(1);
  });
});

describe('clampCopilotCeiling', () => {
  it('clamps a number into bounds and floors it', () => {
    expect(clampCopilotCeiling(6)).toBe(6);
    expect(clampCopilotCeiling(0)).toBe(1);
    expect(clampCopilotCeiling(9999)).toBe(COPILOT_CEILING_MAX);
    expect(clampCopilotCeiling(4.9)).toBe(4);
  });
  it('returns undefined for a non-finite value (⇒ cores-derived default)', () => {
    expect(clampCopilotCeiling(undefined)).toBeUndefined();
    expect(clampCopilotCeiling('x' as unknown as number)).toBeUndefined();
    expect(clampCopilotCeiling(Number.NaN)).toBeUndefined();
  });
});

describe('resolveStageCaps', () => {
  it('returns today\'s defaults when nothing is configured', () => {
    expect(resolveStageCaps({})).toEqual(DEFAULT_STAGE_CAPS);
  });
  it('overlays configured overrides + clamps; Connect is honoured now (SCALE-5)', () => {
    const caps = resolveStageCaps({ stageCaps: { decompose: 5, claims: 999, connect: 4 } });
    expect(caps.decompose).toBe(5);
    expect(caps.claims).toBe(STAGE_CAP_MAX); // clamped
    expect(caps.connect).toBe(4); // SCALE-5: a Connect override is now honoured (was force-pinned to 1)
    expect(caps.compose).toBe(DEFAULT_STAGE_CAPS.compose); // untouched → default
  });
  it('drops a garbled override to the stage default (ENG-15 tolerant)', () => {
    const caps = resolveStageCaps({ stageCaps: { decompose: 'bad' as unknown as number } });
    expect(caps.decompose).toBe(DEFAULT_STAGE_CAPS.decompose);
  });
});

describe('resolveCeilingWrite (SCALE-1 edit contract: preserve / clear / set)', () => {
  it('undefined incoming PRESERVES the prior (#102 preserve-on-omission)', () => {
    expect(resolveCeilingWrite(7, undefined)).toBe(7);
    expect(resolveCeilingWrite(undefined, undefined)).toBeUndefined();
  });
  it('null incoming CLEARS the override (→ undefined ⇒ cores-derived default)', () => {
    expect(resolveCeilingWrite(7, null)).toBeUndefined();
    expect(resolveCeilingWrite(undefined, null)).toBeUndefined();
  });
  it('a number incoming sets the clamped manual override', () => {
    expect(resolveCeilingWrite(7, 3)).toBe(3);
    expect(resolveCeilingWrite(undefined, 9999)).toBe(COPILOT_CEILING_MAX);
    expect(resolveCeilingWrite(2, 0)).toBe(1);
  });
});
