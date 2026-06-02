// Process-wide copilot concurrency limit (SPEC-0014 perf / dogfood #4). One global ceiling that
// EVERY copilot spawner acquires a slot from before launching a `copilot` subprocess — the
// safety bound that makes raising per-stage caps safe. Without it, cap=K across multiple stages
// + jobs + researchers multiplies into K×(stages+jobs+researchers) concurrent `copilot` processes,
// which would hit the CLI/API rate limit and thrash CPU/memory. With it, the total number of
// in-flight copilot subprocesses across the whole process can never exceed the ceiling, no matter
// how many stages/jobs run cap>1 concurrently.
//
// Pure + injectable: the ceiling is read once from env (KB_COPILOT_MAX_CONCURRENCY) or derived
// from CPU count, so it's deterministically testable. A FIFO queue keeps acquisition fair.
import os from 'node:os';

/** Resolve the global ceiling. Env override wins (tests/measure/future per-Instance setting);
 *  else cores-aware, clamped to a small range so a many-core box can't fan out unbounded. */
function resolveCeiling(): number {
  const raw = process.env.KB_COPILOT_MAX_CONCURRENCY;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(4, cores - 1));
}

/**
 * A minimal fair (FIFO) async counting semaphore. `acquire()` resolves once a slot is free,
 * returning a single-use `release`. In-flight count never exceeds `ceiling`.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(public readonly ceiling: number) {}

  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const grant = (): void => {
        this.inFlight++;
        let released = false;
        resolve(() => {
          if (released) return; // idempotent release
          released = true;
          this.inFlight--;
          const next = this.waiters.shift();
          if (next) next(); // hand the freed slot to the next waiter (still ≤ ceiling)
        });
      };
      if (this.inFlight < this.ceiling) grant();
      else this.waiters.push(grant);
    });
  }

  /** Test/diagnostic: how many slots are in use right now. */
  get active(): number {
    return this.inFlight;
  }
  /** Test/diagnostic: how many acquisitions are queued waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }
}

/** The ONE process-wide copilot semaphore. Every copilot spawner shares this instance. */
export const copilotSemaphore = new Semaphore(resolveCeiling());

/**
 * Run `fn` while holding one global copilot slot — the standard wrapper for a one-shot `copilot -p`
 * spawn. Acquires before, releases after (even on throw). For a long-lived SDK session that holds a
 * copilot process for its lifetime, use {@link acquireCopilotSlot} and release on disconnect.
 */
export async function withCopilotSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await copilotSemaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Acquire a slot held across a span the caller controls (e.g. an SDK session). Returns the
 *  single-use release; the caller MUST call it (e.g. in a `finally` / on disconnect). */
export function acquireCopilotSlot(): Promise<() => void> {
  return copilotSemaphore.acquire();
}
