// STAGING-12 — coalesce/throttle promotion to `main` so KB-App is a good citizen of the LIVE Obsidian
// vault. `main` IS the directory Obsidian has open; today the pipeline promotes on EVERY drain
// (~14–46s), and Obsidian's file-watcher re-indexes on every write → indexing/nav/file-load HANG and
// never settle until KB-App is quit. The fix: drains don't promote directly — they `request()` a
// promotion, and the actual `promote()` runs in **infrequent batched bursts**:
//   - debounced by a QUIESCENT window (promote only once the drains go quiet for `quiescentMs`), so a
//     burst of drains coalesces into ONE commit; AND
//   - capped by `maxWaitMs` so continuous processing still publishes at least that often (publication
//     isn't starved — `main` stays additively-forward, just less often).
// Net: the watched tree changes in occasional bursts, not a continuous stream → Obsidian settles
// between them. Pure + dependency-injected (promote fn + timer/clock) so the coalescing is unit-tested.

export interface CoalescingPromoterDeps {
  /** The actual staging→`main` promotion, run serialized under the canonical-writer lock. */
  promote: () => Promise<void>;
  /** Debounce window: promote this long after the LAST request, so a burst of drains coalesces into one. */
  quiescentMs: number;
  /** Hard cap: promote at least this often under continuous drains so publication isn't starved. */
  maxWaitMs: number;
  /** Report a promotion failure (the request stays pending → retried on the next cycle). */
  onError?: (err: unknown) => void;
  /** Injectable timer + clock (tests). Defaults to global setTimeout/clearTimeout + Date.now. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
  };
}

export interface CoalescingPromoter {
  /** A drain changed an evergreen path — schedule a (debounced/capped) promotion. Cheap + synchronous;
   *  does NO git itself, so the per-drain afterDrain hook returns instantly. */
  request(): void;
  /** Promote now if there's a pending request, and await it — for graceful shutdown / QUIESCE so the
   *  last batch is published (never silently dropped). Cancels the pending timer first. */
  flushNow(): Promise<void>;
  /** Cancel the pending timer without promoting (hard stop / vault switch — staging stays the source of
   *  truth, so the next session's drain re-promotes; promotion is idempotent + additive). */
  stop(): void;
  /** Is a promotion pending (a requested batch not yet published, or a promote in flight)? QUIESCE
   *  reads this so "safe to shut down" is never reported while `main` still owes the last batch. */
  pending(): boolean;
}

const defaultScheduler = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: (): number => Date.now(),
};

export function createCoalescingPromoter(deps: CoalescingPromoterDeps): CoalescingPromoter {
  const sched = deps.scheduler ?? defaultScheduler;
  let dirty = false; // a promotion is pending (a drain changed evergreen since the last promote)
  let firstDirtyAt: number | null = null; // when the current pending batch started (for the maxWait cap)
  let timer: unknown = null;
  let promoting: Promise<void> | null = null; // in-flight promote (don't stack — they'd serialize anyway)

  /** (Re)arm the timer for min(quiescent-from-now, cap-from-first-dirty) — debounce, but never past the cap. */
  function arm(): void {
    if (timer !== null) sched.clearTimeout(timer);
    const now = sched.now();
    if (firstDirtyAt === null) firstDirtyAt = now;
    const deadline = Math.min(now + deps.quiescentMs, firstDirtyAt + deps.maxWaitMs);
    timer = sched.setTimeout(() => {
      timer = null;
      void runPromote();
    }, Math.max(0, deadline - now));
  }

  function runPromote(): Promise<void> {
    if (!dirty || promoting) return promoting ?? Promise.resolve();
    dirty = false;
    firstDirtyAt = null;
    promoting = (async () => {
      try {
        await deps.promote();
      } catch (err) {
        deps.onError?.(err);
        dirty = true; // failed → keep the request pending so the next cycle retries (never lose a publish)
      } finally {
        promoting = null;
        if (dirty) arm(); // a request arrived mid-promote (or it failed) → schedule the next burst
      }
    })();
    return promoting;
  }

  return {
    request(): void {
      dirty = true;
      if (promoting) return; // a promote is in flight; it re-arms for the trailing request when it settles
      arm();
    },
    async flushNow(): Promise<void> {
      if (timer !== null) {
        sched.clearTimeout(timer);
        timer = null;
      }
      if (promoting) await promoting; // let an in-flight promote finish first
      if (dirty) await runPromote(); // then publish whatever's still pending
    },
    stop(): void {
      if (timer !== null) {
        sched.clearTimeout(timer);
        timer = null;
      }
    },
    pending(): boolean {
      return dirty || promoting !== null;
    },
  };
}
