// STAGING-12 — the coalescing promoter (pure, node tier). The load-bearing regression: a BURST of
// per-drain promotion requests must collapse into ONE batched promote (not one-per-drain — the
// watcher-storm class that made Obsidian hang), while continuous processing still publishes at the
// maxWait cap (not starved), and graceful shutdown flushes the last pending batch.
import { describe, it, expect, vi } from 'vitest';
import { createCoalescingPromoter } from './coalescingPromoter';

/** A deterministic fake clock + timer queue so the debounce/cap windows are driven explicitly. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return {
    sched: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId++;
        timers.set(id, { fireAt: now + ms, fn });
        return id;
      },
      clearTimeout: (h: unknown): void => {
        timers.delete(h as number);
      },
      now: (): number => now,
    },
    /** Advance the clock by `ms`, firing every timer that comes due (in order), then settle promises. */
    advance: async (ms: number): Promise<void> => {
      now += ms;
      let due = [...timers.entries()].filter(([, t]) => t.fireAt <= now).sort((a, b) => a[1].fireAt - b[1].fireAt);
      while (due.length) {
        for (const [id, t] of due) {
          timers.delete(id);
          t.fn();
        }
        await flushMicrotasks();
        due = [...timers.entries()].filter(([, t]) => t.fireAt <= now).sort((a, b) => a[1].fireAt - b[1].fireAt);
      }
      await flushMicrotasks();
    },
    flushMicrotasks,
  };
}

describe('coalescingPromoter (STAGING-12 — batched bursts, not a per-drain stream)', () => {
  it('REGRESSION: a burst of N per-drain requests coalesces into ONE promote (not N)', async () => {
    const clock = fakeClock();
    const promote = vi.fn().mockResolvedValue(undefined);
    const p = createCoalescingPromoter({ promote, quiescentMs: 1000, maxWaitMs: 5000, scheduler: clock.sched });

    // 5 drains in rapid succession (like the live ~14–46s stream, compressed) — all within the window.
    for (let i = 0; i < 5; i++) {
      p.request();
      await clock.advance(100); // 5 drains over ~500ms
    }
    expect(promote).not.toHaveBeenCalled(); // nothing promoted mid-burst — the watcher stays quiet

    await clock.advance(1000); // drains go quiet → the quiescent window elapses
    expect(promote).toHaveBeenCalledTimes(1); // ONE batched burst for all 5 drains (was 5 per-drain commits)
  });

  it('promotes at the maxWait cap under continuous drains (publication not starved)', async () => {
    const clock = fakeClock();
    const promote = vi.fn().mockResolvedValue(undefined);
    const p = createCoalescingPromoter({ promote, quiescentMs: 1000, maxWaitMs: 5000, scheduler: clock.sched });

    // A drain every 900ms (< quiescent) so the debounce never elapses — only the cap can fire it.
    p.request();
    for (let t = 0; t < 4500; t += 900) {
      await clock.advance(900);
      expect(promote).not.toHaveBeenCalled(); // still batching — no per-drain churn
      p.request();
    }
    await clock.advance(900); // crosses the 5000ms cap
    expect(promote).toHaveBeenCalledTimes(1); // fired once at the cap, not once-per-drain
  });

  it('does nothing when no drain ever requests a promotion', async () => {
    const clock = fakeClock();
    const promote = vi.fn().mockResolvedValue(undefined);
    createCoalescingPromoter({ promote, quiescentMs: 1000, maxWaitMs: 5000, scheduler: clock.sched });
    await clock.advance(10_000);
    expect(promote).not.toHaveBeenCalled();
  });

  it('pending() reports an owed batch (so QUIESCE never says "safe" before main is current)', async () => {
    const clock = fakeClock();
    const promote = vi.fn().mockResolvedValue(undefined);
    const p = createCoalescingPromoter({ promote, quiescentMs: 1000, maxWaitMs: 5000, scheduler: clock.sched });
    expect(p.pending()).toBe(false);
    p.request();
    expect(p.pending()).toBe(true); // owed — not yet published
    await clock.advance(1000);
    expect(p.pending()).toBe(false); // promoted → nothing owed
  });

  it('flushNow() publishes the pending batch immediately (graceful shutdown / QUIESCE)', async () => {
    const clock = fakeClock();
    const promote = vi.fn().mockResolvedValue(undefined);
    const p = createCoalescingPromoter({ promote, quiescentMs: 30_000, maxWaitMs: 60_000, scheduler: clock.sched });
    p.request();
    expect(promote).not.toHaveBeenCalled(); // timer hasn't elapsed
    await p.flushNow();
    expect(promote).toHaveBeenCalledTimes(1); // flushed without waiting the window
  });

  it('a promote FAILURE keeps the request pending so the next cycle retries (never loses a publish)', async () => {
    const clock = fakeClock();
    const onError = vi.fn();
    const promote = vi.fn().mockRejectedValueOnce(new Error('lock timed out')).mockResolvedValue(undefined);
    const p = createCoalescingPromoter({ promote, quiescentMs: 1000, maxWaitMs: 5000, onError, scheduler: clock.sched });

    p.request();
    await clock.advance(1000); // first promote fires → throws
    expect(promote).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    await clock.advance(1000); // it stayed dirty + re-armed → retries
    expect(promote).toHaveBeenCalledTimes(2); // retried (the second resolves)
  });

  it('a request arriving during an in-flight promote schedules a follow-up burst', async () => {
    const clock = fakeClock();
    let release!: () => void;
    const promote = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = () => r())))
      .mockResolvedValue(undefined);
    const p = createCoalescingPromoter({ promote, quiescentMs: 1000, maxWaitMs: 5000, scheduler: clock.sched });

    p.request();
    await clock.advance(1000); // promote #1 starts (pending — not resolved)
    expect(promote).toHaveBeenCalledTimes(1);
    p.request(); // a new drain lands while #1 is in flight
    release(); // #1 resolves → should re-arm for the trailing request
    await clock.flushMicrotasks();
    await clock.advance(1000); // its follow-up window elapses
    expect(promote).toHaveBeenCalledTimes(2); // the in-flight drain got its own later burst
  });
});
