// @vitest-environment happy-dom
//
// #145 UI load-resilience — `withTimeout` (a hung IPC must reject, not hang forever) + `renderLoadError`
// (a retryable fallback instead of an infinite spinner). withTimeout is timer logic (fake timers);
// renderLoadError needs a DOM (happy-dom).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withTimeout, renderLoadError, TimeoutError, LOAD_TIMEOUT_MS } from './loadGuard';

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
