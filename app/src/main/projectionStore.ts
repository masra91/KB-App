// SHELL-12: the cached-PROJECTION backbone — the shared spine that makes the renderer NEVER block on a
// backend op. Generalized from OBS-24's status snapshot store (`statusSnapshot.ts`, now a thin adapter
// over this): every surface (status · reviews · settings · activity) reads a maintained last-known-good
// projection INSTANTLY off this store — the render path does zero git/fs/lock/recompute. A background
// refresher recomputes on a cadence OFF the render path; a slow/blocked compute simply yields a
// slightly-stale projection (honest — every read carries `builtAt` + `stale`), NEVER a render-path
// timeout. The last-known-good is persisted so launch shows the surface instantly, then goes live.
//
// Dependency-injected (compute / persistence / clock / scheduler / push) so it's unit-testable without
// a real backend, timer, or filesystem.
//
// The `Projection<T>` envelope is the cross-boundary contract (the renderer reads it too), so it lives
// in the neutral `kb/types`; this store owns the mechanics that maintain it.
import type { Projection, ProjectionStatus } from '../kb/types';

export type { Projection, ProjectionStatus };

export interface ProjectionStoreDeps<T> {
  /** The expensive compute (the former synchronous recompute) — run ONLY on the background cadence,
   *  never the render path. Returns null when there's nothing to project (e.g. no active KB). */
  compute: () => Promise<T | null>;
  /** Background refresh cadence in ms. */
  intervalMs: number;
  /** ISO clock for `builtAt` (injectable for tests). Default `new Date().toISOString()`. */
  now?: () => string;
  /** Load the persisted last-known-good payload (shown instantly on launch); null if none. Read at
   *  `start()` so it reflects the now-active context. Best-effort (errors → null). */
  load?: () => T | null;
  /** Persist a freshly-computed payload as the new last-known-good. Best-effort (errors swallowed). */
  save?: (data: T) => void;
  /** Report a background compute failure (the last-known-good projection is retained, marked stale). */
  onError?: (err: unknown) => void;
  /** PUSH hook (SHELL-12 (c)) — fired after each refresh that changes the projection, so the renderer
   *  can re-read instantly instead of waiting on a live recompute. Best-effort (errors swallowed). */
  onUpdate?: (projection: Projection<T>) => void;
  /** Injectable timer (tests). Defaults to global setInterval/clearInterval. */
  scheduler?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
}

export interface ProjectionStore<T> {
  /** The last-known-good projection, or null if none computed/persisted yet. INSTANT — no compute. */
  current(): Projection<T> | null;
  /** Begin background refresh (immediate first refresh + on the cadence). Seeds from persistence.
   *  Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Stop background refresh. Retains the in-memory projection. */
  stop(): void;
  /** Run one refresh now and await it (used by `start`, post-mutation seams, and tests; coalesces
   *  concurrent calls so a slow compute never stacks). */
  refreshNow(): Promise<void>;
}

const defaultScheduler = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createProjectionStore<T>(deps: ProjectionStoreDeps<T>): ProjectionStore<T> {
  const sched = deps.scheduler ?? defaultScheduler;
  const now = deps.now ?? ((): string => new Date().toISOString());
  let projection: Projection<T> | null = null;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null; // coalesce overlapping refreshes (a slow compute must not stack)

  function set(data: T | null, stale: boolean, status: ProjectionStatus): void {
    if (data === null) {
      projection = null; // compute reported nothing to project → nothing to show (consumer = warming)
      return;
    }
    projection = { data, builtAt: now(), stale, status };
    try {
      deps.onUpdate?.(projection);
    } catch {
      /* push is best-effort — a listener failure must never break the projection */
    }
  }

  async function doRefresh(): Promise<void> {
    try {
      const next = await deps.compute();
      if (next !== null) {
        set(next, false, 'ready'); // a live refresh succeeded → fresh + ready
        try {
          deps.save?.(next);
        } catch {
          /* persistence is best-effort — a write failure must never break the projection */
        }
      } else {
        projection = null;
      }
    } catch (err) {
      deps.onError?.(err);
      // STATE-10: keep the last-known-good payload but mark it stale + status 'error' (the cause is
      // surfaced via onError, never the scary "app busy" string) — staleness is honest, a timeout is not.
      if (projection) set(projection.data, true, 'error');
    }
  }

  function refreshNow(): Promise<void> {
    // Coalesce: while a refresh is running, callers await the same one (no stacked computes).
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    current: () => projection,
    start() {
      if (timer !== null) return;
      // Seed instantly from the persisted last-known-good for the now-active context, then go live.
      if (deps.load) {
        try {
          const loaded = deps.load();
          // STATE-11 cold start: render the persisted last-known-good instantly, marked `warming` —
          // it's shown but the first live refresh hasn't confirmed it yet (auto-resolves to `ready` on
          // the refresh below / via push), so the surface shows a calm "indexing…", never an error.
          if (loaded !== null) projection = { data: loaded, builtAt: now(), stale: true, status: 'warming' };
        } catch {
          projection = null;
        }
      }
      void refreshNow(); // don't wait a full interval for the first live projection
      timer = sched.setInterval(() => void refreshNow(), deps.intervalMs);
    },
    stop() {
      if (timer !== null) {
        sched.clearInterval(timer);
        timer = null;
      }
    },
    refreshNow,
  };
}
