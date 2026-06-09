// Disposition + posture rules (SPEC-0023 JOBS-9/15) and preset cadence. Pure functions, no FS/git.
import { describe, it, expect } from 'vitest';
import {
  effectiveDisposition,
  normalizeJournalEntry,
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

describe('normalizeJournalEntry — JOBS-8 read-boundary coercion (the "undefined" run-detail fix)', () => {
  it('passes a well-formed entry through unchanged', () => {
    const e = { ts: '2026-06-02T07:00:00.000Z', runId: 'R1', inspected: 'entities/ (3 nodes)', applied: 1, deferred: 2 };
    expect(normalizeJournalEntry(e)).toEqual(e);
  });

  it('a LEGACY/partial line missing the JOBS-8 counts → 0/0 and inspected "" (never undefined)', () => {
    // Regression: the run detail showed "inspected undefined; undefined applied, undefined deferred"
    // because a legacy line lacked these fields and `JSON.parse(...) as JournalEntry` cast them to undefined.
    const legacy = { ts: '2026-06-01T00:00:00.000Z', runId: 'OLD' }; // pre-JOBS-8 shape
    expect(normalizeJournalEntry(legacy)).toEqual({ ts: '2026-06-01T00:00:00.000Z', runId: 'OLD', inspected: '', applied: 0, deferred: 0 });
  });

  it('coerces wrong-typed / non-finite counts to 0 and a non-string inspected to ""', () => {
    const malformed = { ts: 1234, runId: 'X', inspected: 42, applied: 'oops', deferred: NaN };
    expect(normalizeJournalEntry(malformed)).toEqual({ ts: '', runId: 'X', inspected: '', applied: 0, deferred: 0 });
  });

  it('preserves optional findings / cursor / note only when well-typed', () => {
    const findings = [{ summary: 's', kind: 'additive', confidence: 1, disposition: 'auto' }];
    const e = { ts: 't', runId: 'r', inspected: 'i', applied: 1, deferred: 0, findings, cursor: { at: 5 }, note: 'collision-exhausted' };
    expect(normalizeJournalEntry(e)).toMatchObject({ findings, cursor: { at: 5 }, note: 'collision-exhausted' });
    // a junk (non-array / non-object / non-string) optional field is dropped, not carried as garbage
    expect(normalizeJournalEntry({ ts: 't', runId: 'r', inspected: 'i', applied: 0, deferred: 0, findings: 'nope', cursor: 7, note: 9 }))
      .toEqual({ ts: 't', runId: 'r', inspected: 'i', applied: 0, deferred: 0 });
  });

  it('a non-object line → a fully-defaulted entry (never throws, never undefined fields)', () => {
    expect(normalizeJournalEntry(null)).toEqual({ ts: '', runId: '', inspected: '', applied: 0, deferred: 0 });
    expect(normalizeJournalEntry('garbage')).toEqual({ ts: '', runId: '', inspected: '', applied: 0, deferred: 0 });
  });
});
