// Neutral placeholder view (SPEC-0017 SHELL-3) — proves the shell carries more than
// one surface. Intentionally has no real content yet (out of scope, §2).

export function mountPlaceholder(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card placeholder">
      <h1>✨ Coming soon</h1>
      <p class="muted">
        This space is reserved for a future view. The navigation shell is built to
        grow — new views plug in without disturbing the ones already here.
      </p>
    </div>`;
}
