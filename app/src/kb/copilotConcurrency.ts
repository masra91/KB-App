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
  return envCeilingOverride() ?? coresDerivedCeiling();
}

/** The cores-derived ceiling — SCALE-1's "current cores-derived default" (no env, no Settings). */
export function coresDerivedCeiling(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(4, cores - 1));
}

/** The env ceiling override (`KB_COPILOT_MAX_CONCURRENCY`) if a valid ≥1 int, else undefined. SCALE-1:
 *  env still WINS over the Settings value (tests/measure keep their hard override). */
export function envCeilingOverride(): number | undefined {
  const raw = process.env.KB_COPILOT_MAX_CONCURRENCY;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/** Options for {@link Semaphore.acquire}. */
export interface AcquireOptions {
  /**
   * Interactive/foreground acquisition (ASK-16): it jumps AHEAD of background (pipeline) waiters for
   * the next freed slot, so a Principal-initiated op (recall / Ask / Explore) never starves behind
   * continuous ingestion — background yields to the human, never the reverse. Default false (background).
   */
  priority?: boolean;
  /**
   * Bounded wait (ASK-16 honest fast-fail): reject with {@link CopilotCapacityTimeoutError} if no slot
   * is granted within this many ms — so an interactive op fails fast + honestly ("KB is busy ingesting")
   * instead of hanging. Omitted = wait indefinitely (background pipeline acquisitions are patient).
   */
  timeoutMs?: number;
  /**
   * SPEC-0048 SCALE-3 no-starvation: the pipeline STAGE this background acquisition is for
   * (`decompose`/`connect`/`claims`/`compose`/`archive`). The semaphore guarantees that any stage with
   * work keeps ≥1 RESERVED slot — a busy upstream stage (e.g. Decompose at cap 3) can't consume the
   * whole ceiling and starve a downstream stage (Claims/Compose) to zero (the live BLOCKED pathology).
   * Untagged background acquisitions (jobs/researchers) share the remaining pool; priority (interactive)
   * acquisitions are unaffected (they preempt, ASK-16).
   */
  stage?: string;
}

/** A queued acquisition awaiting a slot — carries its lane + the stage it reserves for (SCALE-3). */
interface Waiter {
  grant: () => void;
  stage?: string;
}

/** Thrown by a bounded {@link Semaphore.acquire} when no slot frees within `timeoutMs` (ASK-16). */
export class CopilotCapacityTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`copilot capacity not available within ${timeoutMs}ms`);
    this.name = 'CopilotCapacityTimeoutError';
  }
}

/**
 * A minimal fair async counting semaphore with an interactive PRIORITY lane (ASK-16). `acquire()`
 * resolves once a slot is free, returning a single-use `release`. In-flight count never exceeds
 * `ceiling`. Background waiters are served FIFO; priority (foreground) waiters are served FIRST on
 * release — so a human query reserves the next freed slot ahead of background ingestion. A bounded
 * acquire rejects with {@link CopilotCapacityTimeoutError} rather than hanging.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Waiter[] = []; // background, FIFO (scanned for the reservation rule)
  private readonly priorityWaiters: Waiter[] = []; // interactive/foreground, served before background
  /** In-flight count per stage tag (SCALE-3) — drives the per-stage reservation. Untagged in-flight
   *  acquisitions don't count toward any stage's reservation (they share the leftover pool). */
  private readonly inFlightByStage = new Map<string, number>();
  /** The live concurrency ceiling. Mutable for SPEC-0048 SCALE-1 (Settings-driven ceiling, live-applied
   *  without a restart). `acquire` reads it dynamically, so a resize takes effect on the next acquire. */
  public ceiling: number;
  constructor(ceiling: number) {
    this.ceiling = ceiling;
  }

  /** How many distinct OTHER stages (≠ `exclude`) currently have a queued waiter AND zero in-flight —
   *  i.e. stages still owed their RESERVED first slot. A stage taking a 2nd+ slot must leave this many
   *  free so none of them starves (SCALE-3). */
  private stagesNeedingReservation(exclude: string | undefined): number {
    const set = new Set<string>();
    for (const w of this.waiters) {
      if (w.stage !== undefined && w.stage !== exclude && (this.inFlightByStage.get(w.stage) ?? 0) === 0) set.add(w.stage);
    }
    return set.size;
  }

  /** Whether a BACKGROUND acquisition for `stage` may be granted right now under the reservation rule
   *  (SCALE-3). A stage's FIRST slot (its reservation) is always grantable while any slot is free; a
   *  2nd+ slot (or an untagged acquisition) is granted only if it leaves ≥1 free per other stage still
   *  owed its reserved slot. */
  private canGrantBackground(stage: string | undefined): boolean {
    if (this.inFlight >= this.ceiling) return false;
    const free = this.ceiling - this.inFlight;
    if (stage !== undefined && (this.inFlightByStage.get(stage) ?? 0) === 0) return true; // reserved first slot
    return free > this.stagesNeedingReservation(stage);
  }

  /** Re-evaluate the queues after a release/resize: priority waiters first (ASK-16, always grantable
   *  while a slot is free), then background waiters that satisfy the reservation rule (SCALE-3). */
  private pump(): void {
    while (this.inFlight < this.ceiling && this.priorityWaiters.length > 0) {
      this.priorityWaiters.shift()!.grant();
    }
    let progressed = true;
    while (progressed && this.inFlight < this.ceiling) {
      progressed = false;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.canGrantBackground(this.waiters[i].stage)) {
          this.waiters.splice(i, 1)[0].grant();
          progressed = true; // state changed — re-scan from the top
          break;
        }
      }
    }
  }

  /**
   * Resize the ceiling live (SCALE-1/4). Raising it immediately re-pumps so the freed capacity goes to
   * queued waiters (priority first, then the reservation rule). Lowering it never force-releases an
   * in-flight slot — `inFlight` simply drains below the new ceiling as holders finish. A no-op when unchanged.
   */
  resize(ceiling: number): void {
    const next = Math.max(1, Math.floor(ceiling));
    if (next === this.ceiling) return;
    this.ceiling = next;
    this.pump();
  }

  acquire(opts: AcquireOptions = {}): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      let settled = false; // guards grant-vs-timeout: whichever fires first wins, the other no-ops
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stage = opts.stage;
      const grant = (): void => {
        if (settled) return; // already timed out / settled
        settled = true;
        if (timer) clearTimeout(timer);
        this.inFlight++;
        if (stage !== undefined) this.inFlightByStage.set(stage, (this.inFlightByStage.get(stage) ?? 0) + 1);
        let released = false;
        resolve(() => {
          if (released) return; // idempotent release
          released = true;
          this.inFlight--;
          if (stage !== undefined) {
            const n = (this.inFlightByStage.get(stage) ?? 1) - 1;
            if (n <= 0) this.inFlightByStage.delete(stage);
            else this.inFlightByStage.set(stage, n);
          }
          this.pump();
        });
      };
      // Grant immediately when allowed: priority preempts on any free slot (ASK-16); background respects
      // the per-stage reservation (SCALE-3). Otherwise queue and let `pump` grant it later.
      const grantableNow = opts.priority ? this.inFlight < this.ceiling : this.canGrantBackground(stage);
      if (grantableNow) {
        grant();
        return;
      }
      const queue = opts.priority ? this.priorityWaiters : this.waiters;
      const waiter: Waiter = { grant, stage };
      queue.push(waiter);
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = queue.indexOf(waiter);
          if (idx >= 0) queue.splice(idx, 1); // give up our place in line
          reject(new CopilotCapacityTimeoutError(opts.timeoutMs as number));
        }, opts.timeoutMs);
        timer.unref?.(); // a pending bounded-acquire timer must not keep the process alive
      }
    });
  }

  /** Test/diagnostic: how many slots are in use right now. */
  get active(): number {
    return this.inFlight;
  }
  /** Test/diagnostic: how many acquisitions are queued waiting for a slot (background + priority). */
  get waiting(): number {
    return this.waiters.length + this.priorityWaiters.length;
  }
  /** Test/diagnostic: how many PRIORITY (foreground) acquisitions are queued. */
  get priorityWaiting(): number {
    return this.priorityWaiters.length;
  }
  /** Test/diagnostic: in-flight count for a given stage tag (SCALE-3 reservation). */
  activeForStage(stage: string): number {
    return this.inFlightByStage.get(stage) ?? 0;
  }
}

/** The ONE process-wide copilot semaphore. Every copilot spawner shares this instance. */
export const copilotSemaphore = new Semaphore(resolveCeiling());

/**
 * Apply the effective global ceiling to the shared semaphore (SPEC-0048 SCALE-1/4), precedence
 * **env > Settings(`configured`) > cores-derived**. Called on pipeline start with the `instance.json`
 * value, and again live on a Settings change (resizes without a restart). Returns the effective value
 * so the caller can record/surface it.
 */
export function applyCopilotCeiling(configured?: number): number {
  const effective = envCeilingOverride() ?? (configured !== undefined && configured >= 1 ? Math.floor(configured) : coresDerivedCeiling());
  copilotSemaphore.resize(effective);
  return effective;
}

/** The current effective ceiling (for Settings display / status). */
export function currentCopilotCeiling(): number {
  return copilotSemaphore.ceiling;
}

/**
 * Run `fn` while holding one global copilot slot — the standard wrapper for a one-shot `copilot -p`
 * spawn. Acquires before, releases after (even on throw). For a long-lived SDK session that holds a
 * copilot process for its lifetime, use {@link acquireCopilotSlot} and release on disconnect.
 */
export async function withCopilotSlot<T>(fn: () => Promise<T>, opts: AcquireOptions = {}): Promise<T> {
  const release = await copilotSemaphore.acquire(opts);
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

/** Default bound for an interactive acquire (ASK-16): long enough that a normal background op frees a
 *  slot, short enough to fail fast + honestly instead of the silent 60s `session.idle` hang. */
export const DEFAULT_INTERACTIVE_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Acquire a PRIORITY (interactive/foreground) copilot slot for a Principal-initiated op (recall / Ask /
 * Explore) — ASK-16. It jumps ahead of background ingestion for the next freed slot AND is bounded: if
 * no slot frees within `timeoutMs` it rejects with {@link CopilotCapacityTimeoutError} so the caller can
 * fail honestly + fast ("KB is busy ingesting — retry") rather than hang. Like {@link acquireCopilotSlot},
 * the returned release MUST be called (e.g. on session disconnect). Recall NO LONGER bypasses the pool.
 */
export function acquireInteractiveCopilotSlot(timeoutMs: number = DEFAULT_INTERACTIVE_ACQUIRE_TIMEOUT_MS): Promise<() => void> {
  return copilotSemaphore.acquire({ priority: true, timeoutMs });
}
