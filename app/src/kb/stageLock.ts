// The serialized canonical writer (SPEC-0014 §5 / SPEC-0015 §5). Every pipeline stage
// runs its cognition + worktree work concurrently, but the final step that advances the
// CANONICAL vault ref (fast-forward + refresh root) must go through ONE lock per vault so
// commits land one at a time and two stages never race on the root repo's `index.lock`.
//
// In v1 the engine runs in-process, so a single shared `Mutex` instance — injected into
// every stage of a vault — IS that serialized writer. Capture, archive, and decompose all
// share one lock per vault.

/** A read-only snapshot of the lock for the Status view (SPEC-0030 OBS-7): is the canonical
 *  writer held right now, how many sections are waiting behind it, and (if labelled) who holds it. */
export interface LockState {
  /** True while a critical section is executing. */
  held: boolean;
  /** Sections queued behind the current holder (0 when idle/unheld). */
  waiters: number;
  /** Optional label of the current holder (e.g. the stage), when the caller passed one. */
  holder?: string;
  /** ISO timestamp the current section acquired the lock — so a long hold is visible. */
  since?: string;
}

/** A tiny async mutex: serializes async work so two critical sections never overlap. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  // Introspection bookkeeping (OBS-7) — does NOT affect serialization, only `state()`.
  private pending = 0; // queued + running sections
  private running = false; // a section is executing now
  private holder: string | undefined; // label of the running section (optional)
  private heldSince: string | undefined; // when it acquired

  /**
   * Run `fn` as a serialized critical section. `label` is optional metadata for OBS-7 status
   * (the holder name); it never changes ordering. Semantics are unchanged from the original:
   * `fn` runs after the prior section settles (success OR failure), and the chain advances on
   * `finally` so a failed section never wedges the lock.
   */
  run<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const prev = this.tail;
    this.pending += 1;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runFn = async (): Promise<T> => {
      this.running = true;
      this.holder = label;
      this.heldSince = new Date().toISOString();
      try {
        return await fn();
      } finally {
        this.running = false;
        this.holder = undefined;
        this.heldSince = undefined;
      }
    };
    return prev.then(runFn, runFn).finally(() => {
      this.pending -= 1;
      release();
    });
  }

  /** A read-only snapshot for the Status view (OBS-7). */
  state(): LockState {
    return {
      held: this.running,
      waiters: Math.max(0, this.pending - (this.running ? 1 : 0)),
      ...(this.holder !== undefined ? { holder: this.holder } : {}),
      ...(this.heldSince !== undefined ? { since: this.heldSince } : {}),
    };
  }
}
