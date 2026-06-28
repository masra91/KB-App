// SHELL-12 — the generic cached-projection spine (pure, node tier). The load-bearing guarantees every
// surface (status · reviews · settings · activity) rides on: the render-path read NEVER computes (no
// git/fs/lock on `current()` → a timeout is structurally impossible), the background cadence maintains
// it off the render path, a compute failure RETAINS the last-known-good (marked `stale`), and a
// persisted payload is shown instantly on start. Generalized from OBS-24's status store.
import { describe, it, expect, vi } from 'vitest';
import { createProjectionStore } from './projectionStore';

/** A monotonically-stamping clock so `builtAt` is deterministic + assertable in tests. */
function fakeClock(start = 0) {
  let t = start;
  return () => `t${t++}`;
}

/** A fake scheduler that captures the interval callback so tests drive ticks deterministically. */
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

describe('createProjectionStore (SHELL-12 spine)', () => {
  it('current() is null before any refresh', () => {
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('x'), intervalMs: 1000 });
    expect(store.current()).toBeNull();
  });

  it('refreshNow() populates current() with data + builtAt + stale:false', async () => {
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('hello'), intervalMs: 1000, now: fakeClock() });
    await store.refreshNow();
    expect(store.current()).toEqual({ data: 'hello', builtAt: 't0', stale: false, status: 'ready' });
  });

  it('READS NEVER COMPUTE — current() does zero work on the render path (the SHELL-12 guarantee)', async () => {
    const compute = vi.fn().mockResolvedValue('v');
    const store = createProjectionStore<string>({ compute, intervalMs: 1000 });
    await store.refreshNow(); // 1 compute (background)
    for (let i = 0; i < 50; i++) store.current(); // 50 render-path reads
    expect(compute).toHaveBeenCalledTimes(1); // reads added zero computes → no git/fs on read, never blocks
  });

  it('start() seeds instantly from the persisted last-known-good (marked stale), then refreshes live', async () => {
    const compute = vi.fn().mockResolvedValue('live');
    const fk = fakeScheduler();
    const store = createProjectionStore<string>({ compute, intervalMs: 1000, load: () => 'persisted', scheduler: fk.sched, now: fakeClock() });
    store.start();
    // STATE-11/9: persisted seed renders instantly, marked stale + `warming` (a calm "indexing…").
    expect(store.current()).toMatchObject({ data: 'persisted', stale: true, status: 'warming' });
    await store.refreshNow();
    expect(store.current()).toMatchObject({ data: 'live', stale: false, status: 'ready' }); // then goes live
    expect(fk.isRunning()).toBe(true);
  });

  it('a compute failure RETAINS the last-known-good, marks it STALE, and reports onError — never throws to the reader', async () => {
    const compute = vi.fn().mockResolvedValueOnce('good').mockRejectedValueOnce(new Error('git blocked'));
    const onError = vi.fn();
    const store = createProjectionStore<string>({ compute, intervalMs: 1000, onError, now: fakeClock() });
    await store.refreshNow();
    expect(store.current()).toMatchObject({ data: 'good', stale: false, status: 'ready' });
    await store.refreshNow(); // this compute throws
    // STATE-10: retained + flagged stale + status 'error' (cause via onError) — NOT cleared, NOT thrown.
    expect(store.current()).toMatchObject({ data: 'good', stale: true, status: 'error' });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('compute reporting nothing-to-project (null) clears the projection', async () => {
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue(null), intervalMs: 1000 });
    await store.refreshNow();
    expect(store.current()).toBeNull();
  });

  it('persists each freshly-computed payload as the new last-known-good', async () => {
    const save = vi.fn();
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('v1'), intervalMs: 1000, save });
    await store.refreshNow();
    expect(save).toHaveBeenCalledWith('v1');
  });

  it('onUpdate (the push hook) fires with the new projection after each successful refresh', async () => {
    const onUpdate = vi.fn();
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('v'), intervalMs: 1000, onUpdate, now: fakeClock() });
    await store.refreshNow();
    expect(onUpdate).toHaveBeenCalledWith({ data: 'v', builtAt: 't0', stale: false, status: 'ready' });
  });

  it('a failing onUpdate / save listener never breaks the projection (best-effort push + persist)', async () => {
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('v'),
      intervalMs: 1000,
      onUpdate: () => { throw new Error('listener blew up'); },
      save: () => { throw new Error('disk full'); },
    });
    await expect(store.refreshNow()).resolves.toBeUndefined();
    expect(store.current()?.data).toBe('v'); // projection still set despite the throwing listeners
  });

  it('coalesces overlapping refreshes — a slow compute does not stack', async () => {
    let resolve!: (v: string) => void;
    const compute = vi.fn().mockImplementation(() => new Promise<string>((r) => (resolve = r)));
    const store = createProjectionStore<string>({ compute, intervalMs: 1000 });
    const p1 = store.refreshNow();
    const p2 = store.refreshNow(); // while the first is still pending
    expect(compute).toHaveBeenCalledTimes(1); // both await the same in-flight compute
    resolve('done');
    await Promise.all([p1, p2]);
    expect(store.current()?.data).toBe('done');
  });

  it('start() is idempotent and stop() halts the cadence', () => {
    const fk = fakeScheduler();
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('v'), intervalMs: 1000, scheduler: fk.sched });
    store.start();
    store.start(); // second call is a no-op (no double timer)
    expect(fk.isRunning()).toBe(true);
    store.stop();
    expect(fk.isRunning()).toBe(false);
  });

  it('a bad persisted load never throws out of start() (best-effort seed)', () => {
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('v'),
      intervalMs: 1000,
      load: () => { throw new Error('corrupt snapshot'); },
      scheduler: fakeScheduler().sched,
    });
    expect(() => store.start()).not.toThrow();
    expect(store.current()).toBeNull(); // a failed seed leaves it empty, then the live refresh fills it
  });
});
