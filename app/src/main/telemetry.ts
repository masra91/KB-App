// Main-process telemetry glue (SPEC-0030 OBS-18/20/21/22). Thin composition over the pure kb/
// modules: installs crash capture + starts the memory sampler, and exposes the OBS-22 health readout
// for the Status view-model. Deliberately ELECTRON-FREE — `main.ts` (the composition root) passes the
// Electron `app`/`crashReporter`/`process`/`v8.writeHeapSnapshot` in. Keeping electron out of here
// means `main/pipeline.ts` can import `telemetryHealth` without dragging electron into the node tests
// that import pipeline.ts.

import { createMemorySampler, type MemorySampler, type ElectronProcessMetric } from '../kb/memorySampler';
import { installCrashCapture, readLastCrash, rendererCrashEvent, type ProcessLike, type AppEventsLike, type CrashReporterLike, type RendererErrorReport } from '../kb/crashCapture';
import { currentBreadcrumb } from '../kb/activityBreadcrumb';
import type { DevLog } from '../kb/devlog';
import type { HealthReadout } from '../kb/pipelineStatusView';

/** RSS growth (MB over the rolling window) past which OBS-21 writes a one-off heap snapshot. High on
 *  purpose: a snapshot is hundreds of MB + multi-second, so it should only fire on a real runaway. */
const HEAP_SNAPSHOT_MB = 500;

export interface TelemetryDeps {
  /** App-level dev-log (the crash breadcrumb + mem.sample sink). */
  appLog: DevLog;
  /** Electron userData dir (minidumps + last-crash.json live here). */
  userDataDir: string;
  /** Node `process` (uncaughtException / unhandledRejection). */
  proc: ProcessLike;
  /** Electron `app` (render/child/gpu-process-gone). */
  appEvents: AppEventsLike;
  /** Electron `crashReporter`. */
  crashReporter?: CrashReporterLike;
  /** `() => app.getAppMetrics()`. */
  getAppMetrics?: () => ElectronProcessMetric[] | undefined;
  /** `(file) => v8.writeHeapSnapshot(file)` — injected so this module never imports node:v8. */
  writeHeapSnapshot?: (file: string) => string;
  /** Returns the active vault's `.kb/cache` dir for a heap snapshot, or null when no vault is open. */
  getSnapshotDir?: () => string | null;
  /** Sampler interval override (tests). */
  intervalMs?: number;
}

let sampler: MemorySampler | null = null;
let userDataDirRef: string | null = null;
let appLogRef: DevLog | null = null;

/** Install crash capture + start the memory sampler (OBS-18/20/21). Call once, after app ready. */
export function startTelemetry(deps: TelemetryDeps): void {
  userDataDirRef = deps.userDataDir;
  appLogRef = deps.appLog;

  installCrashCapture({
    proc: deps.proc,
    appEvents: deps.appEvents,
    ...(deps.crashReporter ? { crashReporter: deps.crashReporter } : {}),
    appLog: deps.appLog,
    userDataDir: deps.userDataDir,
    getActivity: currentBreadcrumb,
  });

  sampler = createMemorySampler({
    log: deps.appLog,
    ...(deps.getAppMetrics ? { getAppMetrics: deps.getAppMetrics } : {}),
    ...(deps.writeHeapSnapshot ? { writeHeapSnapshot: deps.writeHeapSnapshot } : {}),
    ...(deps.getSnapshotDir ? { getSnapshotDir: deps.getSnapshotDir } : {}),
    ...(deps.intervalMs ? { intervalMs: deps.intervalMs } : {}),
    heapSnapshotMb: HEAP_SNAPSHOT_MB,
  });
  sampler.start();
}

/** The OBS-22 health readout: latest sample + leak trend (from the sampler) + the last persisted
 *  crash breadcrumb (read fresh so a crash from a PRIOR run shows after relaunch). */
export async function telemetryHealth(): Promise<HealthReadout> {
  const lastCrash = userDataDirRef ? await readLastCrash(userDataDirRef) : null;
  return {
    memory: sampler?.latest() ?? null,
    trend: sampler?.trend() ?? null,
    lastCrash,
  };
}

/** OBS-18 (renderer): record a renderer-side uncaught error / unhandled rejection, forwarded over IPC
 *  (the isolated renderer can't write the app-log itself). Logged loudly; not fatal to main. */
export function noteRendererError(report: RendererErrorReport): void {
  const { event, fields } = rendererCrashEvent(report);
  appLogRef?.error(event, fields);
}

/** Stop the sampler (shutdown). */
export function stopTelemetry(): void {
  sampler?.stop();
  sampler = null;
}
