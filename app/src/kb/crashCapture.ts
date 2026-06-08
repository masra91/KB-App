// Crash capture (SPEC-0030 OBS-18) — turn "captured nothing" into "captured the last known state +
// a symbolicable dump." Today a native/worker trap (the 2026-06-07 V8 `ThreadPoolForegroundWorker`
// SIGTRAP) left no minidump and no breadcrumb. This installs, all LOCAL-ONLY (no upload — PRIN-19):
//
//   1. Electron `crashReporter` with `uploadToServer: false` → local minidumps in `<userData>/Crashpad`.
//   2. JS process handlers — `uncaughtException` / `unhandledRejection`.
//   3. Main-process `render-process-gone` / `child-process-gone` / `gpu-process-crashed`.
//
// Each handler writes a structured `crash.*` entry (reason + stack + the last runId/itemId/stage from
// the activity breadcrumb) to the app-level dev-log, AND synchronously persists a `last-crash.json`
// breadcrumb that survives an imminent exit (read by the Status view on next boot — OBS-22).
//
// CARE (KB-Lead flagged): exit/crash handling. `uncaughtException` preserves Node's default semantics
// — log + persist, best-effort-flush, then exit(1) — so we add a breadcrumb WITHOUT silently swallowing
// a fatal error (a handler that returned without exiting would leave the process running corrupt).
// `unhandledRejection` and the `*-process-gone` events are recorded loudly but do NOT kill the main
// process (they are not, by themselves, a reason to tear the app down — and that matches today).

import fs from 'node:fs';
import path from 'node:path';
import type { DevLog } from './devlog';
import type { ActivityBreadcrumb } from './activityBreadcrumb';

export type CrashKind =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'render-process-gone'
  | 'child-process-gone'
  | 'gpu-process-crashed';

/** The persisted last-crash breadcrumb (read by OBS-22 on the next boot). Numbers/strings only. */
export interface CrashBreadcrumb {
  /** When the crash was recorded (ISO). */
  ts: string;
  kind: CrashKind;
  /** Human reason (error message / process exit reason). */
  reason: string;
  stack?: string;
  /** The last pipeline activity at the moment of the crash (OBS-18). */
  stage?: string;
  itemId?: string;
  runId?: string;
  lastEvent?: string;
}

export const LAST_CRASH_FILE = 'last-crash.json';

/** Path to the persisted breadcrumb under Electron userData. */
export function lastCrashPath(userDataDir: string): string {
  return path.join(userDataDir, LAST_CRASH_FILE);
}

function reasonOf(err: unknown): { reason: string; stack?: string } {
  if (err instanceof Error) return { reason: err.message || err.name || 'Error', stack: err.stack };
  if (typeof err === 'string') return { reason: err };
  try {
    return { reason: JSON.stringify(err) };
  } catch {
    return { reason: String(err) };
  }
}

/** Build the breadcrumb from a crash + the last pipeline activity (pure). */
export function buildCrashBreadcrumb(
  kind: CrashKind,
  err: unknown,
  activity: ActivityBreadcrumb,
  nowIso: string,
): CrashBreadcrumb {
  const { reason, stack } = reasonOf(err);
  return {
    ts: nowIso,
    kind,
    reason,
    ...(stack ? { stack } : {}),
    ...(activity.stage ? { stage: activity.stage } : {}),
    ...(activity.itemId ? { itemId: activity.itemId } : {}),
    ...(activity.runId ? { runId: activity.runId } : {}),
    ...(activity.event ? { lastEvent: activity.event } : {}),
  };
}

/** Persist the breadcrumb SYNCHRONOUSLY — an `uncaughtException` handler may exit before any async
 *  write flushes, so the essential last-known-state is written with `writeFileSync`. Best-effort. */
export function writeCrashBreadcrumbSync(userDataDir: string, bc: CrashBreadcrumb): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(lastCrashPath(userDataDir), JSON.stringify(bc));
  } catch {
    /* persisting the breadcrumb is best-effort — never throw out of a crash handler */
  }
}

/** Read the last persisted crash breadcrumb (OBS-22), or null if none / unreadable / malformed. */
export async function readLastCrash(userDataDir: string): Promise<CrashBreadcrumb | null> {
  try {
    const raw = await fs.promises.readFile(lastCrashPath(userDataDir), 'utf8');
    const obj = JSON.parse(raw) as CrashBreadcrumb;
    return obj && typeof obj.ts === 'string' && typeof obj.kind === 'string' ? obj : null;
  } catch {
    return null;
  }
}

/** A renderer-side uncaught error / unhandled rejection, forwarded to main (the isolated renderer
 *  has no `process` + no fs, so its `window` error events are reported over IPC — OBS-18 "renderer"). */
export interface RendererErrorReport {
  kind: 'error' | 'unhandledrejection';
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
}

/** Map a renderer error report to the app-log event + fields (pure). NOT fatal to the main process —
 *  a renderer JS error is logged loudly but doesn't tear the app down (render-process-gone handles an
 *  actual renderer death). It also does not overwrite the last-crash breadcrumb (that's for crashes). */
export function rendererCrashEvent(report: RendererErrorReport): { event: string; fields: Record<string, unknown> } {
  return {
    event: report.kind === 'unhandledrejection' ? 'crash.renderer-unhandled-rejection' : 'crash.renderer-uncaught',
    fields: {
      fatal: false,
      scope: 'renderer',
      message: report.message,
      ...(report.source ? { source: report.source } : {}),
      ...(typeof report.line === 'number' ? { line: report.line } : {}),
      ...(typeof report.col === 'number' ? { col: report.col } : {}),
      ...(report.stack ? { stack: report.stack } : {}),
    },
  };
}

/** A minimal `process`-like emitter (injectable for tests). */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
/** A minimal Electron-`app`-like emitter (injectable for tests). */
export interface AppEventsLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
/** A minimal Electron-`crashReporter`-like (injectable for tests). */
export interface CrashReporterLike {
  start(opts: { uploadToServer: boolean; [k: string]: unknown }): void;
}

export interface CrashCaptureDeps {
  /** The Node `process` (for `uncaughtException` / `unhandledRejection`). */
  proc: ProcessLike;
  /** The Electron `app` (for `render-process-gone` / `child-process-gone` / `gpu-process-crashed`). */
  appEvents: AppEventsLike;
  /** The Electron `crashReporter`; omitted in unit tests. */
  crashReporter?: CrashReporterLike;
  /** App-level dev-log to write the structured `crash.*` entry into. */
  appLog: DevLog;
  /** Electron userData dir — minidumps + the `last-crash.json` breadcrumb live here. */
  userDataDir: string;
  /** Reads the last-known pipeline activity at crash time. */
  getActivity: () => ActivityBreadcrumb;
  now?: () => string;
  /** Exit hook (default `process.exit`). Injected so tests assert the exit code without dying. */
  exit?: (code: number) => void;
  /** Force-exit on `uncaughtException` (default true — preserves Node's crash-on-uncaught semantics). */
  exitOnUncaught?: boolean;
  /** Bound the pre-exit dev-log flush so a wedged write can't hang the exit. Default 1000ms. */
  flushTimeoutMs?: number;
}

/** Install all crash-capture handlers (OBS-18). Idempotent enough for one boot; call once. */
export function installCrashCapture(deps: CrashCaptureDeps): void {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const exitOnUncaught = deps.exitOnUncaught !== false;
  const flushTimeoutMs = deps.flushTimeoutMs ?? 1000;

  // Local minidumps, NO upload (OBS-18 / PRIN-19). Wrapped: a crashReporter that fails to start must
  // not block the handlers below (they are the cheaper, always-available half of the capture).
  try {
    deps.crashReporter?.start({ uploadToServer: false });
  } catch {
    deps.appLog.warn('crash.reporter-start-failed', {});
  }

  const record = (kind: CrashKind, err: unknown): CrashBreadcrumb => {
    const bc = buildCrashBreadcrumb(kind, err, deps.getActivity(), now());
    // Sync-persist FIRST so the breadcrumb survives even if the async dev-log write never flushes.
    writeCrashBreadcrumbSync(deps.userDataDir, bc);
    deps.appLog.error(`crash.${kind}`, {
      fatal: true,
      reason: bc.reason,
      ...(bc.stage ? { stage: bc.stage } : {}),
      ...(bc.itemId ? { itemId: bc.itemId } : {}),
      ...(bc.runId ? { runId: bc.runId } : {}),
      ...(bc.lastEvent ? { lastEvent: bc.lastEvent } : {}),
      err,
    });
    return bc;
  };

  const flushThen = (after?: () => void): void => {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, flushTimeoutMs));
    void Promise.race([deps.appLog.flush().catch(() => {}), timeout]).then(() => after?.());
  };

  // uncaughtException: record, best-effort flush, then exit(1) — preserving crash-on-uncaught while
  // adding the breadcrumb. NOT exiting here would leave the process running in a corrupt state.
  deps.proc.on('uncaughtException', (err: unknown) => {
    record('uncaughtException', err);
    flushThen(exitOnUncaught ? (): void => exit(1) : undefined);
  });

  // unhandledRejection: loud breadcrumb, but do NOT tear the app down (a rejection is often
  // recoverable; force-exiting would be strictly worse than today's no-handler behaviour).
  deps.proc.on('unhandledRejection', (reason: unknown) => {
    record('unhandledRejection', reason);
    flushThen();
  });

  // Renderer / child (utility) / GPU process death — captured from the main side (this also covers a
  // native renderer crash that an in-renderer JS handler could never see). Main process stays up.
  deps.appEvents.on('render-process-gone', (...args: unknown[]) => {
    const details = args[2] as { reason?: string; exitCode?: number } | undefined;
    record('render-process-gone', new Error(`renderer gone: ${details?.reason ?? 'unknown'} (exit ${details?.exitCode ?? '?'})`));
  });
  deps.appEvents.on('child-process-gone', (...args: unknown[]) => {
    const details = args[1] as { type?: string; reason?: string; exitCode?: number } | undefined;
    record('child-process-gone', new Error(`child gone: ${details?.type ?? '?'} ${details?.reason ?? 'unknown'} (exit ${details?.exitCode ?? '?'})`));
  });
  deps.appEvents.on('gpu-process-crashed', (...args: unknown[]) => {
    const killed = args[1] === true;
    record('gpu-process-crashed', new Error(killed ? 'gpu process killed' : 'gpu process crashed'));
  });
}
