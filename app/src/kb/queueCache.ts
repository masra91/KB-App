// INGEST-PERF item 1 (SPEC-0044 / ORCH series): collapse the redundant O(N) full-tree queue walks
// each drain pass runs. `readDecomposeQueue` / `readConnectQueue` / `readClaimsQueue` each walk the
// whole `sources/` or `entities/` tree and read EVERY audit.jsonl / entity file — and each is called
// twice per drain pass (the initial read + the post-batch re-read), plus once on every 30s safety
// sweep even when nothing changed. On a large, mostly-idle vault that re-reads thousands of files for
// nothing, dominating ingest latency on the read side.
//
// The fix is a per-stage memo keyed on the canonical HEAD sha. The derived work queue is a PURE
// function of the canonical tree (sources/, entities/, candidate files, audit.jsonl, corrections) —
// and EVERY mutation to that tree lands as a canonical commit (advanceOrCollide / the promotion gate /
// a replay epoch advance), because stages only ever write in their own ephemeral worktrees and commit.
// So the canonical HEAD sha is an exact generation counter: identical sha ⇒ byte-identical queue.
//
// That single invariant covers BOTH wins the brief calls out:
//   (a) within a drain pass — the initial read + the re-read share one result whenever no commit landed
//       between them (the idle/empty-queue and systemic-failure cases, i.e. exactly the wasteful ones);
//   (b) between passes — an idle sweep on an unchanged canonical skips the walk entirely instead of
//       re-reading every file for nothing.
// As soon as a batch advances the canonical, HEAD moves, the memo misses, and the queue is recomputed
// fresh — so an active drain ALWAYS sees current state (no staleness, and it even picks up sources a
// concurrent Archive committed mid-pass, which the old per-pass re-walk also did). This never touches
// advanceOrCollide correctness — it is read-side only.
import { canonicalHead } from './canonicalAdvance';

/** Reads the canonical worktree's current HEAD — the generation key. Injectable for tests. */
export type HeadReader = (root: string) => Promise<string>;

/**
 * A per-stage memo of a derived work queue keyed on the canonical HEAD sha. One instance per stage
 * (the stage owns it); `read` returns the cached queue while HEAD is unchanged, else recomputes via
 * `compute` and re-keys. Counters (`hits`/`misses`) make the saved walks assertable in tests + a
 * perf span. Returned values are treated as read-only by every caller (drains only slice + read).
 */
export class CanonicalQueueCache<T> {
  private sha: string | null = null;
  private cached: T | null = null;
  /** Reads served from the memo (a walk skipped) — for the before/after perf proof. */
  hits = 0;
  /** Reads that recomputed (HEAD moved, first read, or HEAD unreadable) — a real walk ran. */
  misses = 0;

  constructor(private readonly headReader: HeadReader = canonicalHead) {}

  /**
   * Return the memoized queue when the canonical HEAD is unchanged since it was computed; otherwise run
   * `compute` (the real tree walk) and memoize it against the current HEAD. If HEAD can't be read we
   * never trust the memo (always recompute) — correctness over the optimization.
   */
  async read(root: string, compute: () => Promise<T>): Promise<T> {
    let head: string | null;
    try {
      head = await this.headReader(root);
    } catch {
      head = null; // can't read HEAD → don't trust the memo this round
    }
    if (head !== null && head === this.sha && this.cached !== null) {
      this.hits += 1;
      return this.cached;
    }
    this.misses += 1;
    const value = await compute();
    this.cached = value;
    this.sha = head; // a null sha can never satisfy the `head !== null && head === sha` hit guard
    return value;
  }

  /** Drop the memo so the next read recomputes (e.g. a stage reset / forced refresh). */
  invalidate(): void {
    this.sha = null;
    this.cached = null;
  }
}
