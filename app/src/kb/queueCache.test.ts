// INGEST-PERF item 1 proof: the canonical-HEAD queue memo recomputes EXACTLY once per generation
// (HEAD sha) and skips the O(N) walk whenever the canonical is unchanged since the last read — which
// is precisely "discovery runs once per drain pass + is skipped when no commit landed since last read."
import { describe, it, expect, vi } from 'vitest';
import { CanonicalQueueCache } from './queueCache';

describe('CanonicalQueueCache', () => {
  /** A controllable HEAD reader + a counting compute — together they model the drain's two call sites. */
  function harness(head: string) {
    let current = head;
    const compute = vi.fn(async () => ['a', 'b', 'c']);
    const headReader = vi.fn(async () => current);
    const cache = new CanonicalQueueCache<string[]>(headReader);
    return { cache, compute, headReader, setHead: (h: string) => (current = h) };
  }

  it('within a pass: the initial read + the re-read share ONE walk when no commit landed between them', async () => {
    const { cache, compute } = harness('sha-1');
    const a = await cache.read('/root', compute); // initial read (drain site 1)
    const b = await cache.read('/root', compute); // re-read on the same canonical (drain site 2)
    expect(compute).toHaveBeenCalledTimes(1); // discovery ran ONCE per pass
    expect(b).toBe(a); // same memoized result reference
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(1);
  });

  it('between passes: an idle sweep on an unchanged canonical skips the walk entirely', async () => {
    const { cache, compute } = harness('sha-1');
    await cache.read('/root', compute); // pass 1
    await cache.read('/root', compute); // pass 2 (sweep), no commit since → skip
    await cache.read('/root', compute); // pass 3 (sweep), still no commit → skip
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.hits).toBe(2);
  });

  it('recomputes a FRESH queue as soon as the canonical HEAD moves (a batch advanced) — no staleness', async () => {
    const { cache, compute, setHead } = harness('sha-1');
    await cache.read('/root', compute);
    setHead('sha-2'); // a batch advanced the canonical
    const fresh = vi.fn(async () => ['x']);
    const after = await cache.read('/root', fresh);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(1); // moved HEAD ⇒ real walk
    expect(after).toEqual(['x']);
    expect(cache.misses).toBe(2);
  });

  it('never trusts the memo when HEAD is unreadable (recomputes every time)', async () => {
    const compute = vi.fn(async () => ['a']);
    const headReader = vi.fn(async () => {
      throw new Error('git revparse failed');
    });
    const cache = new CanonicalQueueCache<string[]>(headReader);
    await cache.read('/root', compute);
    await cache.read('/root', compute);
    expect(compute).toHaveBeenCalledTimes(2); // correctness over the optimization
    expect(cache.hits).toBe(0);
  });

  it('recovers to memoizing once HEAD becomes readable again', async () => {
    const compute = vi.fn(async () => ['a']);
    let fail = true;
    const headReader = vi.fn(async () => {
      if (fail) throw new Error('transient');
      return 'sha-1';
    });
    const cache = new CanonicalQueueCache<string[]>(headReader);
    await cache.read('/root', compute); // HEAD unreadable → recompute
    fail = false;
    await cache.read('/root', compute); // HEAD now sha-1, not cached → recompute + memoize
    await cache.read('/root', compute); // sha-1 unchanged → skip
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cache.hits).toBe(1);
  });

  it('invalidate() forces the next read to recompute even on an unchanged HEAD', async () => {
    const { cache, compute } = harness('sha-1');
    await cache.read('/root', compute);
    cache.invalidate();
    await cache.read('/root', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
