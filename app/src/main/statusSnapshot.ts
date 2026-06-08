// OBS-24: the maintained status PROJECTION. Holds the last-known-good `PipelineStatusView` in memory so
// the render path (Status IPC + the QCAP-14 tray readout) reads it INSTANTLY — it never triggers the
// expensive compute (git worktree/lock enumeration + queue/spans/conversion file reads) that made the
// status poll block behind the pipeline's own git ops and trip the 8s load-guard under load (#256).
//
// A background refresher recomputes on a cadence, OFF the render path. A slow or blocked compute simply
// yields a slightly-stale snapshot (honest — every view carries `builtAt` as its "as of" timestamp),
// NEVER a render-path timeout — the structural guarantee OBS-24 asks for. The last-known-good snapshot
// is persisted so launch shows status instantly, then goes live on the first background refresh.
//
// Pure-ish + dependency-injected (compute / persistence / scheduler) so it's unit-testable without a
// real pipeline, timer, or filesystem.
import type { PipelineStatusView } from '../kb/pipelineStatusView';

export interface StatusSnapshotDeps {
  /** The expensive status compute (the former synchronous recompute) — run ONLY on the background
   *  cadence, never the render path. Returns null when there's no active KB. */
  compute: () => Promise<PipelineStatusView | null>;
  /** Background refresh cadence in ms. */
  intervalMs: number;
  /** Load the persisted last-known-good snapshot for the active KB (shown instantly on launch); null
   *  if none. Read at `start()` so it reflects the now-active vault. Best-effort (errors → null). */
  load?: () => PipelineStatusView | null;
  /** Persist a freshly-computed snapshot as the new last-known-good. Best-effort (errors swallowed). */
  save?: (view: PipelineStatusView) => void;
  /** Report a background compute failure (the last-known-good snapshot is retained). */
  onError?: (err: unknown) => void;
  /** Injectable timer (tests). Defaults to global setInterval/clearInterval. */
  scheduler?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
}

export interface StatusSnapshotStore {
  /** The last-known-good status view, or null if none computed/persisted yet. Instant — no compute. */
  current(): PipelineStatusView | null;
  /** Begin background refresh (immediate first refresh + on the cadence). Seeds from persistence.
   *  Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Stop background refresh. Retains the in-memory snapshot. */
  stop(): void;
  /** Run one refresh now and await it (used by `start` + tests; coalesces concurrent calls). */
  refreshNow(): Promise<void>;
}

const defaultScheduler = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createStatusSnapshotStore(deps: StatusSnapshotDeps): StatusSnapshotStore {
  const sched = deps.scheduler ?? defaultScheduler;
  let snapshot: PipelineStatusView | null = null;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null; // coalesce overlapping refreshes (a slow compute must not stack)

  async function doRefresh(): Promise<void> {
    try {
      const next = await deps.compute();
      if (next) {
        snapshot = next;
        try {
          deps.save?.(next);
        } catch {
          /* persistence is best-effort — a write failure must never break status */
        }
      } else {
        snapshot = null; // compute reported no active KB → nothing to show
      }
    } catch (err) {
      deps.onError?.(err); // keep the last-known-good snapshot — staleness is honest, a timeout is not
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
    current: () => snapshot,
    start() {
      if (timer !== null) return;
      // Seed instantly from the persisted last-known-good for the now-active KB, then go live.
      if (deps.load) {
        try {
          snapshot = deps.load();
        } catch {
          snapshot = null;
        }
      }
      void refreshNow(); // don't wait a full interval for the first live snapshot
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
