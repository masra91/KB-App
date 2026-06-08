// SPEC-0030 OBS-18 — crash capture: handlers + breadcrumb persistence + the exit semantics KB-Lead
// flagged for careful review. All deps are injected so the uncaughtException → exit(1) path runs
// without actually killing the test process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installCrashCapture,
  buildCrashBreadcrumb,
  writeCrashBreadcrumbSync,
  readLastCrash,
  lastCrashPath,
  rendererCrashEvent,
  type CrashCaptureDeps,
} from './crashCapture';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';

const NOW = (): string => '2026-06-08T03:00:00.000Z';

/** A fake DevLog that records calls and resolves flush immediately. */
function fakeLog() {
  const calls: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  return {
    log: {
      debug: (event: string, fields = {}) => calls.push({ level: 'debug', event, fields }),
      info: (event: string, fields = {}) => calls.push({ level: 'info', event, fields }),
      warn: (event: string, fields = {}) => calls.push({ level: 'warn', event, fields }),
      error: (event: string, fields = {}) => calls.push({ level: 'error', event, fields }),
      child: () => fakeLog().log,
      flush: () => Promise.resolve(),
    },
    calls,
  };
}

/** Let queued microtasks + a 0ms timer drain so flushThen()'s `.then(exit)` runs. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('crashCapture pure helpers (OBS-18)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('kb-crash-');
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('buildCrashBreadcrumb folds the crash + last activity', () => {
    const bc = buildCrashBreadcrumb('uncaughtException', new Error('boom'), { stage: 'claims', itemId: 'E1', runId: 'R1', event: 'claims.start' }, NOW());
    expect(bc).toMatchObject({ kind: 'uncaughtException', reason: 'boom', stage: 'claims', itemId: 'E1', runId: 'R1', lastEvent: 'claims.start', ts: NOW() });
    expect(bc.stack).toContain('Error');
  });

  it('writeCrashBreadcrumbSync + readLastCrash round-trip; missing → null', async () => {
    expect(await readLastCrash(dir)).toBeNull();
    const bc = buildCrashBreadcrumb('render-process-gone', new Error('renderer gone'), {}, NOW());
    writeCrashBreadcrumbSync(dir, bc);
    expect(await pathExists(lastCrashPath(dir))).toBe(true);
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'render-process-gone', reason: 'renderer gone' });
  });

  it('readLastCrash returns null on malformed json', async () => {
    const fs = await import('node:fs');
    await fs.promises.writeFile(lastCrashPath(dir), '{not json');
    expect(await readLastCrash(dir)).toBeNull();
  });

  it('rendererCrashEvent maps an uncaught renderer error to a non-fatal app-log entry (OBS-18 renderer)', () => {
    const e = rendererCrashEvent({ kind: 'error', message: 'boom', source: 'app://renderer.js', line: 12, col: 3, stack: 'Error: boom' });
    expect(e.event).toBe('crash.renderer-uncaught');
    expect(e.fields).toMatchObject({ fatal: false, scope: 'renderer', message: 'boom', source: 'app://renderer.js', line: 12, col: 3 });
  });

  it('rendererCrashEvent maps an unhandled rejection', () => {
    const e = rendererCrashEvent({ kind: 'unhandledrejection', message: 'nope' });
    expect(e.event).toBe('crash.renderer-unhandled-rejection');
    expect(e.fields).toMatchObject({ fatal: false, message: 'nope' });
  });
});

describe('installCrashCapture handlers (OBS-18 exit/crash handling)', () => {
  let dir: string;
  let proc: EventEmitter;
  let appEvents: EventEmitter;
  let exits: number[];
  let crashReporterStart: ReturnType<typeof vi.fn>;

  function install(over: Partial<CrashCaptureDeps> = {}) {
    const lg = fakeLog();
    installCrashCapture({
      proc: proc as unknown as CrashCaptureDeps['proc'],
      appEvents: appEvents as unknown as CrashCaptureDeps['appEvents'],
      crashReporter: { start: crashReporterStart },
      appLog: lg.log,
      userDataDir: dir,
      getActivity: () => ({ stage: 'decompose', itemId: 'SRC9', runId: 'R3', event: 'decompose.start' }),
      now: NOW,
      exit: (code: number) => exits.push(code),
      flushTimeoutMs: 50,
      ...over,
    });
    return lg;
  }

  beforeEach(async () => {
    dir = await makeTempDir('kb-crashcap-');
    proc = new EventEmitter();
    appEvents = new EventEmitter();
    exits = [];
    crashReporterStart = vi.fn();
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('starts the crashReporter with uploadToServer:false (local-only, PRIN-19)', () => {
    install();
    expect(crashReporterStart).toHaveBeenCalledWith(expect.objectContaining({ uploadToServer: false }));
  });

  it('uncaughtException → breadcrumb persisted + crash.* error + exit(1) after flush', async () => {
    const lg = install();
    proc.emit('uncaughtException', new Error('worker trap'));
    // breadcrumb is persisted synchronously (survives an imminent exit)
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'uncaughtException', reason: 'worker trap', stage: 'decompose', itemId: 'SRC9', runId: 'R3' });
    const err = lg.calls.find((c) => c.event === 'crash.uncaughtException');
    expect(err).toMatchObject({ level: 'error', fields: expect.objectContaining({ fatal: true, itemId: 'SRC9' }) });
    await tick(); // exit happens after the (bounded) flush resolves
    expect(exits).toEqual([1]);
  });

  it('exitOnUncaught:false records but does NOT exit', async () => {
    install({ exitOnUncaught: false });
    proc.emit('uncaughtException', new Error('boom'));
    await tick();
    expect(exits).toEqual([]);
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'uncaughtException' });
  });

  it('unhandledRejection records loudly but never exits', async () => {
    const lg = install();
    proc.emit('unhandledRejection', new Error('dangling promise'));
    await tick();
    expect(exits).toEqual([]);
    expect(lg.calls.some((c) => c.event === 'crash.unhandledRejection' && c.level === 'error')).toBe(true);
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'unhandledRejection', reason: 'dangling promise' });
  });

  it('render-process-gone records with the reason + does not exit the main process', async () => {
    const lg = install();
    appEvents.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 133 });
    await tick();
    expect(exits).toEqual([]);
    const rec = lg.calls.find((c) => c.event === 'crash.render-process-gone');
    expect(rec?.level).toBe('error');
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'render-process-gone' });
  });

  it('child-process-gone + gpu-process-crashed each leave a breadcrumb', async () => {
    install();
    appEvents.emit('child-process-gone', {}, { type: 'Utility', reason: 'killed', exitCode: 9 });
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'child-process-gone' });
    appEvents.emit('gpu-process-crashed', {}, true);
    expect(await readLastCrash(dir)).toMatchObject({ kind: 'gpu-process-crashed' });
  });

  it('a crashReporter that throws on start does not block handler installation', async () => {
    const lg = install({ crashReporter: { start: () => { throw new Error('no crashpad'); } } });
    proc.emit('uncaughtException', new Error('still captured'));
    expect(await readLastCrash(dir)).toMatchObject({ reason: 'still captured' });
    expect(lg.calls.some((c) => c.event === 'crash.reporter-start-failed')).toBe(true);
  });
});
