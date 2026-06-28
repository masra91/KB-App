// @vitest-environment happy-dom
//
// #145 UI load-resilience — `withTimeout` (a hung IPC must reject, not hang forever) + `renderLoadError`
// (a retryable fallback instead of an infinite spinner). withTimeout is timer logic (fake timers);
// renderLoadError needs a DOM (happy-dom).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  withTimeout,
  renderLoadError,
  renderWarming,
  loadGraphWithWarming,
  reportLoadFailure,
  isWarming,
  TimeoutError,
  LOAD_TIMEOUT_MS,
  GRAPH_LOAD_TIMEOUT_MS,
} from './loadGuard';

describe('withTimeout (#145)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes through a value when the promise resolves in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("passes through the promise's own rejection (not a timeout) when it fails in time", async () => {
    await expect(withTimeout(Promise.reject(new Error('ipc boom')), 1000)).rejects.toThrow('ipc boom');
  });

  it('rejects with a TimeoutError when the promise hangs past the deadline', async () => {
    const hang = new Promise(() => {}); // never settles — models a hung IPC
    const guarded = withTimeout(hang, 1000);
    const assertion = expect(guarded).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('does not time out a promise that settles just before the deadline', async () => {
    let resolve!: (v: string) => void;
    const p = new Promise<string>((r) => (resolve = r));
    const guarded = withTimeout(p, 1000);
    await vi.advanceTimersByTimeAsync(999);
    resolve('ok');
    await expect(guarded).resolves.toBe('ok'); // the cleared timer can't fire afterward
    await vi.advanceTimersByTimeAsync(1000); // no late TimeoutError
  });

  it('defaults to LOAD_TIMEOUT_MS', async () => {
    const guarded = withTimeout(new Promise(() => {}));
    const assertion = expect(guarded).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await assertion;
  });
});

describe('renderLoadError (#145)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  it('renders the view header + a retryable error (no spinner) and wires Retry → onRetry', () => {
    const onRetry = vi.fn();
    renderLoadError(root, '<h1>🛠️ Jobs</h1>', onRetry);
    expect(root.querySelector('h1')?.textContent).toContain('Jobs'); // view still looks like itself
    expect(root.querySelector('.load-error')?.textContent).toContain('Couldn’t load');
    expect(root.textContent).not.toContain('Loading…');
    const retry = root.querySelector<HTMLButtonElement>('.load-retry')!;
    expect(retry).toBeTruthy();
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// SPEC-0058 slice-0 — warming-vs-error: a slow cold-start scan is "warming" (calm), not "broken" (error);
// and a swallowed failure is un-swallowed to the app-log so a packaged walkthrough sees the real cause.
describe('isWarming (SPEC-0058 slice-0 — warming ≠ error)', () => {
  it('treats a TimeoutError as WARMING (the backend is still scanning, not faulted)', () => {
    expect(isWarming(new TimeoutError(8000))).toBe(true);
  });
  it('treats any other throw as a real error (NOT warming)', () => {
    expect(isWarming(new Error('read blew up'))).toBe(false);
    expect(isWarming('weird')).toBe(false);
    expect(isWarming(undefined)).toBe(false);
  });
});

describe('reportLoadFailure (SPEC-0058 slice-0 — un-swallow to the app-log)', () => {
  afterEach(() => {
    delete (window as unknown as { kbApi?: unknown }).kbApi;
  });
  it('forwards the REAL error (view-tagged name + message) to the OBS-18 renderer-error channel', () => {
    const reportRendererError = vi.fn(async () => {});
    (window as unknown as { kbApi: Record<string, unknown> }).kbApi = { reportRendererError };
    reportLoadFailure('explore', new TimeoutError(8000));
    expect(reportRendererError).toHaveBeenCalledTimes(1); // FAILS-BEFORE: the bare catch swallowed it
    const arg = (reportRendererError.mock.calls[0] as unknown[])[0] as { kind: string; message: string };
    expect(arg.kind).toBe('error');
    expect(arg.message).toMatch(/\[explore\] load failed: TimeoutError: timed out after 8000ms/);
  });
  it('never throws when kbApi (or the channel) is absent — telemetry must not mask the failure', () => {
    delete (window as unknown as { kbApi?: unknown }).kbApi;
    expect(() => reportLoadFailure('health', new Error('x'))).not.toThrow();
  });
});

describe('loadGraphWithWarming (SPEC-0058 slice-0)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the value and never fires onWarming when the read is fast', async () => {
    const onWarming = vi.fn();
    await expect(loadGraphWithWarming(() => Promise.resolve('graph'), onWarming)).resolves.toBe('graph');
    expect(onWarming).not.toHaveBeenCalled();
  });

  it('fires onWarming once the read is still pending past the warming threshold (scan continues)', async () => {
    const onWarming = vi.fn();
    let resolve!: (v: string) => void;
    const p = loadGraphWithWarming(() => new Promise<string>((r) => (resolve = r)), onWarming, { warmingAfterMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onWarming).toHaveBeenCalledTimes(1); // calm "still preparing" shown WHILE the scan runs
    resolve('graph');
    await expect(p).resolves.toBe('graph'); // …then it completes and the view paints over the warming face
  });

  it('rejects with a TimeoutError (→ classified WARMING) when even the generous graph bound trips', async () => {
    const onWarming = vi.fn();
    const p = loadGraphWithWarming(() => new Promise<string>(() => {}), onWarming);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(GRAPH_LOAD_TIMEOUT_MS);
    await assertion;
  });
});

describe('renderWarming (SPEC-0058 slice-0 — the calm warming face, NOT the error face)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  it('renders a calm warming line (no error class/copy) + a wired Retry, keeping the view header', () => {
    const onRetry = vi.fn();
    renderWarming(root, '<h1>Explore</h1>', onRetry);
    expect(root.querySelector('h1')?.textContent).toContain('Explore');
    const warming = root.querySelector('.load-warming');
    expect(warming).not.toBeNull();
    expect(warming?.textContent).toMatch(/still preparing/i);
    expect(root.querySelector('.load-error, .error')).toBeNull(); // NOT the alarming error face
    expect(root.textContent).not.toContain('Couldn’t load');
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
