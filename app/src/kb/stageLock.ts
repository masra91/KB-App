// The serialized canonical writer (SPEC-0014 §5 / SPEC-0015 §5). Every pipeline stage
// runs its cognition + worktree work concurrently, but the final step that advances the
// CANONICAL vault ref (fast-forward + refresh root) must go through ONE lock per vault so
// commits land one at a time and two stages never race on the root repo's `index.lock`.
//
// In v1 the engine runs in-process, so a single shared `Mutex` instance — injected into
// every stage of a vault — IS that serialized writer. Capture, archive, and decompose all
// share one lock per vault.

/** A tiny async mutex: serializes async work so two critical sections never overlap. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(fn, fn).finally(release);
  }
}
