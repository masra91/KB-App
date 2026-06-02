// Deterministic interleaving tests for the optimistic canonical advance (SPEC-0014 ORCH-17/18/19).
// Real git against a throwaway repo (TEST-18). No agents — we drive the git mechanics directly and
// force the exact interleavings the lock would otherwise hide: two items prepared off the SAME base,
// advanced in sequence, so the second sees a moved canonical (disjoint→replay, same-path→collision).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from './vault';
import { canonicalHead, advanceOrCollide, withOptimisticAdvance, withConcurrentAdvance, withEphemeralWorktree, type AdvanceOutcome } from './canonicalAdvance';
import { Mutex } from './stageLock';

/** A canonical worktree (`root`) on branch `canon` with one initial commit. */
async function makeCanonicalRepo(dir: string): Promise<string> {
  const root = path.join(dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const git = simpleGit(root);
  await git.init(['--initial-branch=canon']);
  await ensureGitIdentity(git);
  await fs.writeFile(path.join(root, 'README'), 'seed\n');
  await git.raw('add', '-A');
  await git.commit('seed');
  return root;
}

/** Simulate a stage's OFF-lock prepare: a worktree synced to `base` on `branch`, writing `files`,
 *  committed there (the work branch then holds the prepared commit). Mirrors the real stages. */
async function prepareOnBranch(root: string, branch: string, base: string, files: Record<string, string>): Promise<void> {
  const wt = path.join(root, '.kb', 'cache', `wt-${branch.replace(/\W/g, '_')}`);
  const git = simpleGit(root);
  await git.raw('worktree', 'add', '--force', '-B', branch, wt, base);
  const wtGit = simpleGit(wt);
  await ensureGitIdentity(wtGit);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), content, 'utf8');
  }
  await wtGit.raw('add', '-A');
  await wtGit.commit(`work on ${branch}`);
  await git.raw('worktree', 'remove', '--force', wt);
}

/** Write `files` into a worktree + commit on its current branch — what a stage's `prepare` does. */
async function commitInWt(wt: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), content, 'utf8');
  }
  const g = simpleGit(wt);
  await ensureGitIdentity(g);
  await g.raw('add', '-A');
  await g.commit('work');
}

const headCount = async (root: string): Promise<number> =>
  Number((await simpleGit(root).raw('rev-list', '--count', 'HEAD')).trim());
const mergeCommitCount = async (root: string): Promise<number> =>
  Number((await simpleGit(root).raw('rev-list', '--merges', '--count', 'HEAD')).trim());
const exists = async (root: string, rel: string): Promise<boolean> =>
  fs.access(path.join(root, rel)).then(() => true).catch(() => false);

describe.skipIf(!gitAvailable)('advanceOrCollide — optimistic canonical advance (ORCH-18)', () => {
  it('fast-forwards when the canonical has not moved (the cap=1 common path)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      await prepareOnBranch(root, 'kb/work-a', base, { 'sources/A/x': 'a' });

      expect(await advanceOrCollide(root, 'kb/work-a', base)).toBe('advanced');
      expect(await exists(root, 'sources/A/x')).toBe(true);
      expect(await headCount(root)).toBe(2); // seed + A, linear
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('replays a DISJOINT item onto a moved canonical (cherry-pick), keeping history linear', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      // Two items prepared off the SAME base, disjoint paths (unique-ULID keying, ORCH-6).
      await prepareOnBranch(root, 'kb/work-a', base, { 'sources/A/x': 'a' });
      await prepareOnBranch(root, 'kb/work-b', base, { 'sources/B/y': 'b' });

      expect(await advanceOrCollide(root, 'kb/work-a', base)).toBe('advanced'); // ff (head===base)
      // B still sees `base`, but canonical moved to A → must replay onto the new HEAD.
      expect(await advanceOrCollide(root, 'kb/work-b', base)).toBe('advanced'); // cherry-pick, disjoint
      expect(await exists(root, 'sources/A/x')).toBe(true);
      expect(await exists(root, 'sources/B/y')).toBe(true);
      expect(await headCount(root)).toBe(3); // seed + A + B(replayed), no merge bubble
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('detects a SAME-PATH collision and leaves the canonical untouched + clean', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      await prepareOnBranch(root, 'kb/work-a', base, { 'entities/p/steve.md': 'A wins' });
      await prepareOnBranch(root, 'kb/work-b', base, { 'entities/p/steve.md': 'B wins' }); // same path

      expect(await advanceOrCollide(root, 'kb/work-a', base)).toBe('advanced');
      const headAfterA = await canonicalHead(root);
      expect(await advanceOrCollide(root, 'kb/work-b', base)).toBe('collision'); // cherry-pick conflict
      // Canonical is unchanged by the collision and the worktree is clean (cherry-pick aborted).
      expect(await canonicalHead(root)).toBe(headAfterA);
      expect(await fs.readFile(path.join(root, 'entities/p/steve.md'), 'utf8')).toBe('A wins');
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('withOptimisticAdvance — prepare/advance/retry/set-aside (ORCH-17/19)', () => {
  it('advances on the happy path (no contention)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work' },
        async (base) => {
          await prepareOnBranch(root, 'kb/work', base, { 'sources/A/x': 'a' });
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('advanced');
      expect(setAside).toBe(false);
      expect(await exists(root, 'sources/A/x')).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('returns noop when prepare commits nothing', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work' },
        async () => false, // nothing to advance
        async () => {},
      );
      expect(result).toBe('noop');
      expect(await headCount(root)).toBe(1); // canonical untouched
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a disjoint racer is reconciled by replay on the first attempt (no set-aside)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work' },
        async (base) => {
          await prepareOnBranch(root, 'kb/work', base, { 'sources/MINE/x': 'mine' });
          // A racing item lands a DISJOINT change on canonical between our base-capture and advance.
          await prepareOnBranch(root, 'kb/racer', base, { 'sources/RACER/y': 'race' });
          await advanceOrCollide(root, 'kb/racer', base);
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('advanced'); // replayed cleanly over the disjoint racer
      expect(setAside).toBe(false);
      expect(await exists(root, 'sources/MINE/x')).toBe(true);
      expect(await exists(root, 'sources/RACER/y')).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('sets aside after K same-path collisions — never dropped, canonical clean (ORCH-19)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      let attempts = 0;
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work', maxCollisionRetries: 2 },
        async (base) => {
          attempts++;
          await prepareOnBranch(root, 'kb/work', base, { 'entities/p/steve.md': `mine ${attempts}` });
          // A racing item lands a conflicting SAME-PATH change every attempt → always collides.
          await prepareOnBranch(root, 'kb/racer', base, { 'entities/p/steve.md': `racer ${attempts}` });
          await advanceOrCollide(root, 'kb/racer', base);
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('setaside');
      expect(setAside).toBe(true);
      expect(attempts).toBe(3); // maxCollisionRetries(2) + 1 initial attempt
      // The item was never half-applied: canonical holds only the racer's content, tree clean.
      expect(await fs.readFile(path.join(root, 'entities/p/steve.md'), 'utf8')).toContain('racer');
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('withEphemeralWorktree — per-item isolation for cap>1 (ORCH-17/20)', () => {
  it('runs fn in a fresh worktree on a unique branch off the checkpoint, then tears it down', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      let seenWt = '';
      let seenBranch = '';
      const advanced = await withEphemeralWorktree(root, 'decompose', base, async ({ wt, workBranch }) => {
        seenWt = wt;
        seenBranch = workBranch;
        await fs.mkdir(path.join(wt, 'sources/A'), { recursive: true });
        await fs.writeFile(path.join(wt, 'sources/A/x'), 'a');
        const g = simpleGit(wt);
        await ensureGitIdentity(g);
        await g.raw('add', '-A');
        await g.commit('work');
        return advanceOrCollide(root, workBranch, base); // advance in the canonical worktree
      });
      expect(advanced).toBe('advanced');
      expect(seenBranch).toMatch(/^kb\/decompose-work-/);
      expect(await exists(root, 'sources/A/x')).toBe(true);
      // Torn down: the worktree dir is gone and its branch deleted.
      expect(await exists('', seenWt)).toBe(false);
      expect((await simpleGit(root).branchLocal()).all).not.toContain(seenBranch);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('concurrent items get ISOLATED worktrees + branches; both land linearly (cap>1 core)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      const lock = new Mutex();
      const seen: Array<{ wt: string; branch: string }> = [];
      // Each item: own ephemeral worktree → write+commit → advance UNDER the lock (inside the
      // ephemeral scope, before teardown). Two run concurrently off the SAME base.
      const run = (name: string): Promise<AdvanceOutcome> =>
        withEphemeralWorktree(root, 'decompose', base, async ({ wt, workBranch }) => {
          seen.push({ wt, branch: workBranch });
          await fs.mkdir(path.join(wt, `sources/${name}`), { recursive: true });
          await fs.writeFile(path.join(wt, `sources/${name}/x`), name);
          const g = simpleGit(wt);
          await ensureGitIdentity(g);
          await g.raw('add', '-A');
          await g.commit(`work ${name}`);
          return lock.run(() => advanceOrCollide(root, workBranch, base));
        });
      const outcomes = await Promise.all([run('A'), run('B')]);
      expect(outcomes).toEqual(['advanced', 'advanced']); // ff then disjoint cherry-pick
      expect(seen[0].wt).not.toBe(seen[1].wt); // isolated worktrees
      expect(seen[0].branch).not.toBe(seen[1].branch); // unique per-item branches
      expect(await exists(root, 'sources/A/x')).toBe(true);
      expect(await exists(root, 'sources/B/x')).toBe(true);
      expect(await mergeCommitCount(root)).toBe(0); // linear (ORCH-3)
    } finally {
      await rmTempDir(dir);
    }
  });

  it('tears the worktree down even when fn throws', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      let seenWt = '';
      await expect(
        withEphemeralWorktree(root, 'claims', base, async ({ wt }) => {
          seenWt = wt;
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await exists('', seenWt)).toBe(false); // cleaned up despite the throw
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('withConcurrentAdvance — ephemeral-worktree wrapper for cap>1 (ORCH-20)', () => {
  it('advances on the happy path — prepare writes in the helper-provided ephemeral worktree', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      const result = await withConcurrentAdvance(
        { root, lock: new Mutex(), stage: 'decompose' },
        async ({ wt }) => {
          await commitInWt(wt, { 'sources/A/x': 'a' });
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('advanced');
      expect(setAside).toBe(false);
      expect(await exists(root, 'sources/A/x')).toBe(true);
      // The ephemeral worktree was torn down (no leak under .kb/cache/worktrees/decompose-*).
      const wtDir = path.join(root, '.kb', 'cache', 'worktrees');
      const leftover = (await fs.readdir(wtDir).catch(() => [] as string[])).filter((d) => d.startsWith('decompose-'));
      expect(leftover).toEqual([]);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('returns noop when prepare commits nothing', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const result = await withConcurrentAdvance({ root, lock: new Mutex(), stage: 'decompose' }, async () => false, async () => {});
      expect(result).toBe('noop');
      expect(await headCount(root)).toBe(1);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('sets aside after K same-path collisions — never dropped, canonical clean (ORCH-19)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      let attempts = 0;
      const result = await withConcurrentAdvance(
        { root, lock: new Mutex(), stage: 'connect', maxCollisionRetries: 2 },
        async ({ wt, base }) => {
          attempts++;
          await commitInWt(wt, { 'entities/p/steve.md': `mine ${attempts}` });
          // A racing item lands a conflicting SAME-PATH change every attempt → always collides.
          await prepareOnBranch(root, 'kb/racer', base, { 'entities/p/steve.md': `racer ${attempts}` });
          await advanceOrCollide(root, 'kb/racer', base);
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('setaside');
      expect(setAside).toBe(true);
      expect(attempts).toBe(3); // maxCollisionRetries(2) + 1
      expect(await fs.readFile(path.join(root, 'entities/p/steve.md'), 'utf8')).toContain('racer');
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
