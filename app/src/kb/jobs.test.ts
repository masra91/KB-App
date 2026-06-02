// Disposition + posture rules (SPEC-0023 JOBS-9/15) and preset cadence. Pure functions, no FS/git.
import { describe, it, expect } from 'vitest';
import {
  effectiveDisposition,
  PRESET_INTERVAL_MS,
  HIGH_CONFIDENCE,
  type JobFinding,
} from './jobs';

const finding = (over: Partial<JobFinding> = {}): JobFinding => ({
  summary: 'x',
  kind: 'additive',
  confidence: 1,
  proposed: 'auto',
  ...over,
});

describe('effectiveDisposition — posture enforcement (JOBS-9/15)', () => {
  it('guarded: additive + high-confidence auto-applies', () => {
    expect(effectiveDisposition(finding({ kind: 'additive', confidence: HIGH_CONFIDENCE }), 'guarded')).toBe('auto');
  });

  it('guarded: destructive → Review regardless of confidence (never guessed)', () => {
    expect(effectiveDisposition(finding({ kind: 'destructive', confidence: 1, proposed: 'auto' }), 'guarded')).toBe('review');
  });

  it('guarded: low-confidence additive → Review', () => {
    expect(effectiveDisposition(finding({ kind: 'additive', confidence: HIGH_CONFIDENCE - 0.01 }), 'guarded')).toBe('review');
  });

  it('autonomous: the behavior’s proposed disposition governs (even destructive auto)', () => {
    expect(effectiveDisposition(finding({ kind: 'destructive', confidence: 0.5, proposed: 'auto' }), 'autonomous')).toBe('auto');
    expect(effectiveDisposition(finding({ proposed: 'review' }), 'autonomous')).toBe('review');
  });
});

describe('preset cadence (JOBS-2)', () => {
  it('orders coarsely: several-daily < hourly? no — several-daily is 6h, hourly 1h, daily 24h', () => {
    expect(PRESET_INTERVAL_MS.hourly).toBeLessThan(PRESET_INTERVAL_MS['several-daily']);
    expect(PRESET_INTERVAL_MS['several-daily']).toBeLessThan(PRESET_INTERVAL_MS.daily);
  });
});
