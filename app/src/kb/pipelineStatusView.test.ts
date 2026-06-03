// SPEC-0030 OBS-5/11 — the Status view-model assembler + per-stage state derivation (pure).
import { describe, it, expect } from 'vitest';
import {
  deriveStageState,
  deriveStageError,
  assemblePipelineStatus,
  setAsideReason,
  toSetAsideViews,
  buildInFlightRoster,
  DEFAULT_STALL_MS,
  DEFAULT_ERROR_FRESH_MS,
  type AssembleParts,
  type StageInput,
  type RecentError,
} from './pipelineStatusView';
import type { PerfIndex } from './perfIndex';
import type { LockState } from './stageLock';

const PERF: PerfIndex = {
  version: 1, builtAt: 'T', source: null, spanCount: 0, truncated: false,
  copilot: { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0 }, stages: [],
  whereTimeGoes: { totalMs: 0, copilotMs: 0, otherMs: 0, copilotPct: 0 }, slowest: [],
};
const UNHELD: LockState = { held: false, waiters: 0 };
const ZERO_CONV = { captured: 0, candidates: 0, entities: 0, claims: 0, promoted: 0 };

function parts(over: Partial<AssembleParts> = {}): AssembleParts {
  return { stages: [], lock: UNHELD, recentErrors: [], worktrees: [], perf: PERF, setAsideItems: [], conversion: ZERO_CONV, inFlight: [], ...over };
}
const stage = (o: Partial<StageInput> & { stage: string }): StageInput => ({
  queueDepth: 0, setAside: 0, busy: false, hasError: false, ...o,
});

describe('deriveStageState (OBS-5)', () => {
  it('error wins over everything (even while draining)', () => {
    expect(deriveStageState({ queueDepth: 3, busy: true, hasError: true })).toBe('error');
  });
  it('busy → running', () => {
    expect(deriveStageState({ queueDepth: 2, busy: true, hasError: false })).toBe('running');
  });
  it('empty queue, not busy → idle', () => {
    expect(deriveStageState({ queueDepth: 0, busy: false, hasError: false })).toBe('idle');
  });
  it('queued but not draining → blocked', () => {
    expect(deriveStageState({ queueDepth: 5, busy: false, hasError: false })).toBe('blocked');
  });
});

describe('deriveStageError (#163 — stale error badge fix)', () => {
  const NOW = Date.parse('2026-06-02T20:00:00.000Z');
  const err = (stage: string, ts: string, level = 'error'): RecentError => ({ ts, level, event: `${stage}.failed`, stage });

  it('a FRESH error marks the stage errored', () => {
    const errs = [err('claims', '2026-06-02T19:59:30.000Z')]; // 30s ago
    expect(deriveStageError(errs, 'claims', NOW)).toBe(true);
  });

  it('a STALE error does NOT — a recovered stage clears (the #163 bug: was unbounded → stuck red)', () => {
    const errs = [err('claims', '2026-06-02T19:50:00.000Z')]; // 10min ago > 2min window
    expect(deriveStageError(errs, 'claims', NOW)).toBe(false);
    // the OLD unbounded check (`some(level error && stage)`) would have returned true here.
  });

  it('respects the freshness window boundary', () => {
    const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
    expect(deriveStageError([err('claims', at(DEFAULT_ERROR_FRESH_MS - 1))], 'claims', NOW)).toBe(true);
    expect(deriveStageError([err('claims', at(DEFAULT_ERROR_FRESH_MS + 1))], 'claims', NOW)).toBe(false);
  });

  it('ignores a fresh error for a DIFFERENT stage', () => {
    expect(deriveStageError([err('decompose', '2026-06-02T19:59:30.000Z')], 'claims', NOW)).toBe(false);
  });

  it('ignores a fresh WARN (only error-level marks the badge)', () => {
    expect(deriveStageError([err('claims', '2026-06-02T19:59:30.000Z', 'warn')], 'claims', NOW)).toBe(false);
  });

  it('a re-failing stage stays red (its latest error is fresh) even with an older one too', () => {
    const errs = [err('claims', '2026-06-02T19:40:00.000Z'), err('claims', '2026-06-02T19:59:50.000Z')];
    expect(deriveStageError(errs, 'claims', NOW)).toBe(true);
  });

  it('tolerates an unparseable timestamp (skips it, never throws)', () => {
    expect(deriveStageError([err('claims', 'not-a-date')], 'claims', NOW)).toBe(false);
  });
});

describe('assemblePipelineStatus (OBS-5/11)', () => {
  it('overall=running when a stage is draining', () => {
    const v = assemblePipelineStatus(parts({ stages: [stage({ stage: 'decompose', busy: true, queueDepth: 1 })] }));
    expect(v.overall).toBe('running');
    expect(v.stalled).toBe(false);
    expect(v.stages[0].state).toBe('running');
  });

  it('overall=running when the lock is held (even if no stage flag is set)', () => {
    const v = assemblePipelineStatus(parts({ lock: { held: true, waiters: 2, holder: 'connect' } }));
    expect(v.overall).toBe('running');
    expect(v.lock.holder).toBe('connect');
  });

  it('#163: a STUCK held lock → overall=stalled (not "running") — the wedge is surfaced, not masked', () => {
    const v = assemblePipelineStatus(parts({ lock: { held: true, waiters: 1, holder: 'claims:advance', stuck: true, heldMs: 45000 } }));
    expect(v.overall).toBe('stalled'); // would be 'running' (lock.held) without the stuck override
    expect(v.stalled).toBe(true);
    expect(v.lock.stuck).toBe(true);
  });

  it('overall=idle when all queues are empty and nothing runs', () => {
    const v = assemblePipelineStatus(parts({ stages: [stage({ stage: 'claims' }), stage({ stage: 'connect' })] }));
    expect(v.overall).toBe('idle');
  });

  it('overall=stalled when work is queued but last activity is older than the threshold (OBS-11)', () => {
    const now = '2026-06-02T00:10:00.000Z';
    const v = assemblePipelineStatus(
      parts({ stages: [stage({ stage: 'decompose', queueDepth: 2 })], lastActivity: '2026-06-02T00:00:00.000Z' }),
      { now: () => now }, // 10min since last activity > 5min default
    );
    expect(v.overall).toBe('stalled');
    expect(v.stalled).toBe(true);
    expect(v.stages[0].state).toBe('blocked'); // queued, not draining
  });

  it('overall=running (not stalled) when queued but recently active', () => {
    const now = '2026-06-02T00:01:00.000Z';
    const v = assemblePipelineStatus(
      parts({ stages: [stage({ stage: 'decompose', queueDepth: 2 })], lastActivity: '2026-06-02T00:00:30.000Z' }),
      { now: () => now }, // 30s < 5min
    );
    expect(v.overall).toBe('running');
  });

  it('queued with NO recorded activity is treated as stalled (infinite age)', () => {
    const v = assemblePipelineStatus(parts({ stages: [stage({ stage: 'decompose', queueDepth: 1 })] }));
    expect(v.overall).toBe('stalled');
  });

  it('carries lock, recentErrors, worktrees, perf, builtAt through', () => {
    const v = assemblePipelineStatus(
      parts({
        recentErrors: [{ ts: 'T', level: 'error', event: 'decompose.failed', stage: 'decompose', itemId: 'SRC1' }],
        worktrees: [{ path: '/v/.kb/cache/worktrees/staging', branch: 'staging' }],
        setAsideItems: [{ stage: 'claims', itemId: 'E9', reason: 'set aside after 3 attempts' }],
        conversion: { captured: 10, candidates: 14, entities: 7, claims: 22, promoted: 6 },
      }),
      { now: () => 'BUILT' },
    );
    expect(v.recentErrors[0].itemId).toBe('SRC1');
    expect(v.worktrees[0].branch).toBe('staging');
    expect(v.perf).toBe(PERF);
    expect(v.setAsideItems[0]).toMatchObject({ stage: 'claims', itemId: 'E9' }); // OBS-17 passthrough
    expect(v.conversion).toEqual({ captured: 10, candidates: 14, entities: 7, claims: 22, promoted: 6 }); // VIZ-3 passthrough
    expect(v.builtAt).toBe('BUILT');
  });

  it('exposes the default stall threshold', () => {
    expect(DEFAULT_STALL_MS).toBe(300000);
  });
});

describe('set-aside view mapping (OBS-17 / CLAIMS-20)', () => {
  it('setAsideReason prefers the failure count, pluralizing correctly', () => {
    expect(setAsideReason(3, 0)).toBe('set aside after 3 failed attempts');
    expect(setAsideReason(1, 0)).toBe('set aside after 1 failed attempt');
  });

  it('setAsideReason falls back to review rounds (cascade cap), then a generic line', () => {
    expect(setAsideReason(0, 2)).toBe('set aside after 2 review rounds (cascade cap)');
    expect(setAsideReason(0, 1)).toBe('set aside after 1 review round (cascade cap)');
    expect(setAsideReason(0, 0)).toBe('set aside after repeated failures');
  });

  it('toSetAsideViews maps a stage’s items to the view shape (stage·name·reason)', () => {
    const views = toSetAsideViews([
      { itemId: '01ABCID', name: 'Ada Lovelace', failures: 3, rounds: 0 },
      { itemId: '01XYZID', name: 'Grace Hopper', failures: 0, rounds: 2 },
    ], 'claims');
    expect(views).toEqual([
      { stage: 'claims', itemId: '01ABCID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' },
      { stage: 'claims', itemId: '01XYZID', name: 'Grace Hopper', reason: 'set aside after 2 review rounds (cascade cap)' },
    ]);
  });

  it('toSetAsideViews tags the passed stage (e.g. connect) — stage-agnostic', () => {
    const views = toSetAsideViews([{ itemId: 'block:engine', name: 'Analytical Engine', failures: 2, rounds: 0 }], 'connect');
    expect(views).toEqual([{ stage: 'connect', itemId: 'block:engine', name: 'Analytical Engine', reason: 'set aside after 2 failed attempts' }]);
  });

  it('toSetAsideViews is empty for no items', () => {
    expect(toSetAsideViews([], 'claims')).toEqual([]);
  });
});

describe('buildInFlightRoster (SPEC-0032 VIZ-2)', () => {
  it('marks the draining batch active (busy && index < cap) with sinceTs; queued items are calm', () => {
    const r = buildInFlightRoster([
      { stage: 'claims', items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }], busy: true, cap: 3, since: 'T1' },
    ]);
    expect(r.map((x) => x.active ?? false)).toEqual([true, true, true, false]); // first 3 (cap) active
    expect(r[0]).toEqual({ itemId: 'A', name: 'A', stage: 'claims', active: true, sinceTs: 'T1' });
    expect(r[3]).toEqual({ itemId: 'D', name: 'D', stage: 'claims' }); // queued: no active, no sinceTs
  });

  it('an idle stage has no active carriages (busy=false → all queued, no sinceTs)', () => {
    const r = buildInFlightRoster([{ stage: 'connect', items: [{ id: 'k1' }], busy: false, cap: 1, since: null }]);
    expect(r[0]).toEqual({ itemId: 'k1', name: 'k1', stage: 'connect' });
  });

  it('uses a provided name, falls back to the id; omits sinceTs when active but since is null', () => {
    const r = buildInFlightRoster([{ stage: 'decompose', items: [{ id: 'S1', name: 'Ada bio' }], busy: true, cap: 1, since: null }]);
    expect(r[0]).toEqual({ itemId: 'S1', name: 'Ada bio', stage: 'decompose', active: true }); // no sinceTs (since null)
  });

  it('flattens multiple stages in order', () => {
    const r = buildInFlightRoster([
      { stage: 'archive', items: [{ id: 'src' }], busy: true, cap: 1, since: 'T0' },
      { stage: 'claims', items: [{ id: 'e1' }], busy: false, cap: 3, since: null },
    ]);
    expect(r.map((x) => x.stage)).toEqual(['archive', 'claims']);
  });
});
