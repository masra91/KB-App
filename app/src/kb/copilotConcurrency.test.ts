// Tests for the process-wide copilot concurrency limit (dogfood #4). Proves the global ceiling
// holds even when many spawners (stages + jobs + researchers) contend at once — the safety bound
// that makes raising per-stage caps safe. Deterministic: no copilot, just instrumented async work.
import { describe, it, expect } from 'vitest';
import { Semaphore, withCopilotSlot, acquireCopilotSlot, copilotSemaphore, CopilotCapacityTimeoutError } from './copilotConcurrency';

/** Run `n` tasks concurrently through `gate`, each holding its slot for a tick; return the peak
 *  number ever in-flight simultaneously. */
async function peakConcurrency(n: number, gate: <T>(fn: () => Promise<T>) => Promise<T>): Promise<number> {
  let inFlight = 0;
  let peak = 0;
  const task = (): Promise<void> =>
    gate(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot briefly so contention is real
      inFlight--;
    });
  await Promise.all(Array.from({ length: n }, task));
  return peak;
}

describe('Semaphore (copilot concurrency primitive)', () => {
  it('never lets in-flight exceed the ceiling under heavy contention', async () => {
    const sem = new Semaphore(3);
    const peak = await peakConcurrency(20, (fn) => withSem(sem, fn));
    expect(peak).toBe(3); // reaches the ceiling (not over-serialized) AND never exceeds it
  });

  it('serializes fully at ceiling 1', async () => {
    const sem = new Semaphore(1);
    const peak = await peakConcurrency(8, (fn) => withSem(sem, fn));
    expect(peak).toBe(1);
  });

  it('grants slots FIFO (fairness)', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const release0 = await sem.acquire(); // take the only slot
    // queue three waiters in order
    const waiters = [1, 2, 3].map((i) =>
      sem.acquire().then((rel) => {
        order.push(i);
        rel();
      }),
    );
    expect(sem.waiting).toBe(3);
    release0(); // free the slot → waiters drain in FIFO order
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release is idempotent (double-release cannot over-grant a slot)', async () => {
    const sem = new Semaphore(1);
    const rel = await sem.acquire();
    rel();
    rel(); // second release is a no-op
    expect(sem.active).toBe(0);
    // a fresh acquire still respects the ceiling
    const peak = await peakConcurrency(5, (fn) => withSem(sem, fn));
    expect(peak).toBe(1);
  });

  it('drains every task (no deadlock/leak): all resolve, ends at zero in-flight', async () => {
    const sem = new Semaphore(2);
    let done = 0;
    await Promise.all(Array.from({ length: 30 }, () => withSem(sem, async () => { done++; })));
    expect(done).toBe(30);
    expect(sem.active).toBe(0);
    expect(sem.waiting).toBe(0);
  });
});

// ASK-16: the interactive PRIORITY lane — a foreground (recall/Ask/Explore) acquire jumps ahead of
// background (pipeline) waiters, and a bounded acquire fails fast instead of hanging.
describe('Semaphore priority lane + bounded acquire (ASK-16)', () => {
  it('serves a PRIORITY waiter before earlier-queued background waiters on the next freed slot', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const hold = await sem.acquire(); // saturate the only slot (the "pipeline" holds it)
    // Two BACKGROUND waiters queue first, THEN a PRIORITY (interactive) waiter arrives last.
    const bg1 = sem.acquire().then((rel) => { order.push('bg1'); rel(); });
    const bg2 = sem.acquire().then((rel) => { order.push('bg2'); rel(); });
    const fg = sem.acquire({ priority: true }).then((rel) => { order.push('fg'); rel(); });
    expect(sem.waiting).toBe(3);
    expect(sem.priorityWaiting).toBe(1);
    hold(); // free the slot → the human jumps the queue despite arriving last (background yields)
    await Promise.all([bg1, bg2, fg]);
    expect(order[0]).toBe('fg'); // FOREGROUND served first; FAILS-BEFORE (plain FIFO) → 'bg1'
    expect(order).toEqual(['fg', 'bg1', 'bg2']);
    expect(sem.active).toBe(0);
  });

  it('a bounded acquire FAILS FAST (CopilotCapacityTimeoutError) when no slot frees in time', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire(); // never released within the bound → saturated/wedged pool
    await expect(sem.acquire({ priority: true, timeoutMs: 20 })).rejects.toBeInstanceOf(CopilotCapacityTimeoutError);
    expect(sem.waiting).toBe(0); // the timed-out waiter gave up its place in line (no leak)
    hold();
    expect(sem.active).toBe(0);
  });

  it('a bounded acquire RESOLVES (and cancels its timer) when a slot frees within the bound', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const fg = sem.acquire({ priority: true, timeoutMs: 1000 });
    setTimeout(hold, 5); // a background op frees the slot well within the bound
    const rel = await fg; // resolves, does not reject
    expect(sem.active).toBe(1);
    rel();
    expect(sem.active).toBe(0);
  });

  it('priority + bounded acquisitions still never exceed the ceiling', async () => {
    const sem = new Semaphore(2);
    const peak = await peakConcurrency(20, (fn) => withSemPriority(sem, fn));
    expect(peak).toBe(2);
  });
});

describe('withCopilotSlot / acquireCopilotSlot (the shared global slot)', () => {
  it('a flood of mixed stage+job+researcher spawners never exceeds the global ceiling', async () => {
    const ceiling = copilotSemaphore.ceiling;
    // Simulate all three spawner families contending on the ONE shared semaphore at once.
    const flood = ceiling * 4 + 7;
    const peak = await peakConcurrency(flood, withCopilotSlot);
    expect(peak).toBeLessThanOrEqual(ceiling); // the global bound holds...
    expect(peak).toBe(ceiling); // ...and is actually reached (cap>1 parallelism works)
    expect(copilotSemaphore.active).toBe(0); // fully drained
  });

  it('releases the slot even when the wrapped work throws', async () => {
    const before = copilotSemaphore.active;
    await expect(withCopilotSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(copilotSemaphore.active).toBe(before); // no leaked slot
  });

  it('acquireCopilotSlot hands back a working release (session-hold pattern)', async () => {
    const release = await acquireCopilotSlot();
    expect(copilotSemaphore.active).toBeGreaterThanOrEqual(1);
    release();
    expect(copilotSemaphore.active).toBe(0);
  });
});

/** Local helper: run `fn` holding one slot of `sem` (mirrors withCopilotSlot but on an explicit instance). */
async function withSem<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Like {@link withSem} but acquires through the interactive PRIORITY lane (ASK-16). */
async function withSemPriority<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire({ priority: true });
  try {
    return await fn();
  } finally {
    release();
  }
}
