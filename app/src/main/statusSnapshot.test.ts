// OBS-24 — the maintained status snapshot store (pure, node tier). The load-bearing guarantees:
// the render-path read NEVER computes (no git/fs on read → timeout structurally impossible), the
// background cadence maintains it off the render path, a compute failure keeps the last-known-good,
// and a persisted snapshot is shown instantly on start.
import { describe, it, expect, vi } from 'vitest';
import { createStatusSnapshotStore } from './statusSnapshot';
import type { PipelineStatusView } from '../kb/pipelineStatusView';

/** A distinguishable fake view — the store treats it opaquely; only `builtAt` matters as the "as of". */
const view = (builtAt: string): PipelineStatusView => ({ overall: 'running', builtAt } as unknown as PipelineStatusView);

/** A fake scheduler that captures the interval callback so tests can drive ticks deterministically. */
function fakeScheduler() {
  let cb: (() => void) | null = null;
  return {
    sched: {
      setInterval: (fn: () => void) => {
        cb = fn;
        return 1;
      },
      clearInterval: () => {
        cb = null;
      },
    },
    tick: () => cb?.(),
    isRunning: () => cb !== null,
  };
}

describe('statusSnapshot store (OBS-24 maintained projection)', () => {
  it('current() is null before any refresh', () => {
    const store = createStatusSnapshotStore({ compute: vi.fn().mockResolvedValue(view('t1')), intervalMs: 1000 });
    expect(store.current()).toBeNull();
  });

  it('refreshNow() populates current() from the background compute', async () => {
    const store = createStatusSnapshotStore({ compute: vi.fn().mockResolvedValue(view('t1')), intervalMs: 1000 });
    await store.refreshNow();
    expect(store.current()?.builtAt).toBe('t1');
  });

  it('READS NEVER COMPUTE — current() does no work on the render path (the OBS-24 guarantee)', async () => {
    const compute = vi.fn().mockResolvedValue(view('t1'));
    const store = createStatusSnapshotStore({ compute, intervalMs: 1000 });
    await store.refreshNow(); // 1 compute (background)
    for (let i = 0; i < 50; i++) store.current(); // 50 render-path reads
    expect(compute).toHaveBeenCalledTimes(1); // reads added zero computes → no git/fs on read, no timeout
  });

  it('start() seeds instantly from the persisted last-known-good, then refreshes live', async () => {
    const compute = vi.fn().mockResolvedValue(view('live'));
    const fk = fakeScheduler();
    const store = createStatusSnapshotStore({ compute, intervalMs: 1000, load: () => view('persisted'), scheduler: fk.sched });
    store.start();
    expect(store.current()?.builtAt).toBe('persisted'); // shown instantly on launch (before live compute resolves)
    await store.refreshNow();
    expect(store.current()?.builtAt).toBe('live'); // then goes live
    expect(fk.isRunning()).toBe(true);
  });

  it('the background cadence maintains the snapshot off the render path', async () => {
    const compute = vi.fn().mockResolvedValueOnce(view('a')).mockResolvedValueOnce(view('b')).mockResolvedValue(view('c'));
    const fk = fakeScheduler();
    const store = createStatusSnapshotStore({ compute, intervalMs: 1000, scheduler: fk.sched });
    store.start(); // immediate refresh (a)
    await store.refreshNow();
    expect(store.current()?.builtAt).toBe('a');
    fk.tick();
    await store.refreshNow();
    expect(store.current()?.builtAt).toBe('b'); // a cadence tick advanced it without any render-path read
  });

  it('a compute failure RETAINS the last-known-good snapshot (staleness is honest, a timeout is not)', async () => {
    const compute = vi.fn().mockResolvedValueOnce(view('good')).mockRejectedValueOnce(new Error('git blocked'));
    const onError = vi.fn();
    const store = createStatusSnapshotStore({ compute, intervalMs: 1000, onError });
    await store.refreshNow();
    expect(store.current()?.builtAt).toBe('good');
    await store.refreshNow(); // this compute throws
    expect(store.current()?.builtAt).toBe('good'); // retained — NOT cleared, NOT thrown to the reader
    expect(onError).toHaveBeenCalledOnce();
  });

  it('persists each freshly-computed snapshot as the new last-known-good', async () => {
    const save = vi.fn();
    const store = createStatusSnapshotStore({ compute: vi.fn().mockResolvedValue(view('t1')), intervalMs: 1000, save });
    await store.refreshNow();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ builtAt: 't1' }));
  });

  it('compute reporting no active KB (null) clears the snapshot', async () => {
    const store = createStatusSnapshotStore({ compute: vi.fn().mockResolvedValue(null), intervalMs: 1000 });
    await store.refreshNow();
    expect(store.current()).toBeNull();
  });

  it('coalesces overlapping refreshes — a slow compute does not stack', async () => {
    let resolve!: (v: PipelineStatusView) => void;
    const compute = vi.fn().mockImplementation(() => new Promise<PipelineStatusView>((r) => (resolve = r)));
    const store = createStatusSnapshotStore({ compute, intervalMs: 1000 });
    const p1 = store.refreshNow();
    const p2 = store.refreshNow(); // while the first is still pending
    expect(compute).toHaveBeenCalledTimes(1); // both await the same in-flight compute
    resolve(view('t1'));
    await Promise.all([p1, p2]);
    expect(store.current()?.builtAt).toBe('t1');
  });

  it('stop() halts the cadence', () => {
    const fk = fakeScheduler();
    const store = createStatusSnapshotStore({ compute: vi.fn().mockResolvedValue(view('t1')), intervalMs: 1000, scheduler: fk.sched });
    store.start();
    expect(fk.isRunning()).toBe(true);
    store.stop();
    expect(fk.isRunning()).toBe(false);
  });
});
