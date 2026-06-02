// SPEC-0030 OBS-5/11 — the Status view-model assembler + per-stage state derivation (pure).
import { describe, it, expect } from 'vitest';
import {
  deriveStageState,
  assemblePipelineStatus,
  DEFAULT_STALL_MS,
  type AssembleParts,
  type StageInput,
} from './pipelineStatusView';
import type { PerfIndex } from './perfIndex';
import type { LockState } from './stageLock';

const PERF: PerfIndex = {
  version: 1, builtAt: 'T', source: null, spanCount: 0, truncated: false,
  copilot: { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0 }, stages: [],
  whereTimeGoes: { totalMs: 0, copilotMs: 0, otherMs: 0, copilotPct: 0 }, slowest: [],
};
const UNHELD: LockState = { held: false, waiters: 0 };

function parts(over: Partial<AssembleParts> = {}): AssembleParts {
  return { stages: [], lock: UNHELD, recentErrors: [], worktrees: [], perf: PERF, ...over };
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
      }),
      { now: () => 'BUILT' },
    );
    expect(v.recentErrors[0].itemId).toBe('SRC1');
    expect(v.worktrees[0].branch).toBe('staging');
    expect(v.perf).toBe(PERF);
    expect(v.builtAt).toBe('BUILT');
  });

  it('exposes the default stall threshold', () => {
    expect(DEFAULT_STALL_MS).toBe(300000);
  });
});
