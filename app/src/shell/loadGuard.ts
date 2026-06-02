// UI load-resilience helpers (#145, hardening PANEL-9). A Manage view that `await`s a main-process
// IPC read shows a "Loading…" placeholder until it resolves. If that IPC **hangs** (e.g. the backend
// is reading degraded staging and never returns), the view would spin forever — a `catch` alone
// doesn't help because the promise never rejects. `withTimeout` bounds the wait so a hung/slow load
// surfaces as a catchable failure, and `renderLoadError` gives the user a retryable fallback instead
// of an infinite spinner. DOM-light + view-agnostic so every Manage view shares one implementation.

/** Default load timeout for a Manage-view IPC read. Generous enough not to false-trip a merely-slow
 *  first load, short enough that a genuine hang doesn't strand the user staring at a spinner. */
export const LOAD_TIMEOUT_MS = 8000;

/** Thrown by {@link withTimeout} when the wrapped promise doesn't settle in time. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `p` against a timeout: resolves/rejects with `p`'s outcome if it settles within `ms`, otherwise
 * rejects with a {@link TimeoutError}. The timer is cleared as soon as `p` settles (no dangling timer).
 * A hung IPC therefore becomes a normal rejection the caller's existing `catch` can handle.
 */
export function withTimeout<T>(p: Promise<T>, ms: number = LOAD_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Render a **retryable** "couldn't load" fallback into a Manage view's container (#145). `headerHtml`
 * is the view's own trusted header block (its `<h1>` + any intro), kept so the view still looks like
 * itself in the error state; `onRetry` re-runs the view's load. The Retry button is wired here so
 * every view gets the same affordance. `headerHtml` is a static, code-supplied literal (not user
 * data), so it is intentionally not escaped.
 */
export function renderLoadError(container: HTMLElement, headerHtml: string, onRetry: () => void): void {
  container.innerHTML = `<div class="card">${headerHtml}<p class="error load-error">Couldn’t load — the app may be busy or still starting up. <button type="button" class="btn load-retry">Retry</button></p></div>`;
  container.querySelector<HTMLButtonElement>('.load-retry')?.addEventListener('click', () => onRetry());
}
