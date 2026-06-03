// Regression gate for #163 (P0): the canonical-writer git ops run UNDER the shared lock, so a git
// op that blocks indefinitely (a zombie `index.lock`, a credential/editor prompt, a stalled fetch,
// a hung hook) would hold the lock FOREVER and wedge the whole pipeline — silently (no throw, just
// a blocked child). That is the #163 mechanism (no static re-entrancy exists; see lockReentrancy.test).
//
// The fix routes `advanceOrCollide` (canonicalAdvance) + `promote` (staging) through `boundedGit`,
// so a blocked op REJECTS within the timeout → the section's `finally` releases the lock → the
// stuck-section watchdog (#170) surfaces it, instead of a permanent silent deadlock.
//
// These tests drive the REAL functions against a throwaway repo, using a pre-commit hook that
// blocks far longer than the (test-shortened) bound as the deterministic stand-in for a hung git.
// Fails-before/passes-after: revert the fix to raw `simpleGit` (no timeout) and the blocked commit
// hangs → these time out and fail.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from './vault';
import { advanceOrCollide } from './canonicalAdvance';
import { promote } from './staging';
import { Mutex } from './stageLock';

const BLOCK_MS = 500; // the bounded-git timeout we drive the canonical writers with (fast for tests)
const SETTLE_BUDGET = 2500; // a bounded op rejects well within this; a hang blows past it → sentinel

const TIMEOUT = Symbol('did-not-settle');
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), ms))]);
}

/** Hooks that block far longer than the bounded-git timeout → the next commit STALLS: the
 *  deterministic stand-in for a real in-section git hang. Covers BOTH commit paths — `pre-commit`
 *  for a plain `git commit` (promote), and `post-commit` for a `cherry-pick` (advanceOrCollide's
 *  replay), which doesn't run `pre-commit`/`commit-msg` but DOES run `post-commit` and waits for it
 *  before the git subprocess returns. Either way the bounded git subprocess can't outlast the hang. */
async function installBlockingCommitHooks(root: string): Promise<void> {
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
    const hook = path.join(root, '.git', 'hooks', name);
    await fs.writeFile(hook, '#!/bin/sh\nsleep 5\n', 'utf8');
    await fs.chmod(hook, 0o755);
  }
}

async function makeRepo(dir: string): Promise<string> {
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

describe.skipIf(!gitAvailable)('#163 — canonical-writer git is time-bounded (no silent lock wedge)', () => {
  it('promote rejects (does not hang) when its in-section commit blocks, and the lock is released', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeRepo(dir);
      const git = simpleGit(root);
      // A `staging` branch carrying an evergreen path, so promote stages a change and reaches commit.
      await git.raw('checkout', '-b', 'staging');
      await fs.mkdir(path.join(root, 'sources', 's1'), { recursive: true });
      await fs.writeFile(path.join(root, 'sources', 's1', 'source.md'), '# s1\n');
      await git.raw('add', '-A');
      await git.commit('staging: a source');
      await git.raw('checkout', 'canon');
      await installBlockingCommitHooks(root);

      // Run promote UNDER the lock — the real #163 shape. With the fix it rejects (bounded git aborts
      // the hung commit) so the section's `finally` releases; pre-fix (raw simpleGit) it would hang.
      const lock = new Mutex();
      const promoting = lock.run(() => promote(root, ['sources'], BLOCK_MS), 'promote');
      const outcome = await within(
        promoting.then(() => 'resolved' as const, () => 'rejected' as const),
        SETTLE_BUDGET,
      );
      expect(outcome).toBe('rejected'); // not the TIMEOUT sentinel (a hang), not a silent success

      // The lock must be FREE — the whole point of #163: a subsequent section acquires + completes.
      const after = await within(lock.run(async () => 'ran', 'after'), SETTLE_BUDGET);
      expect(after).toBe('ran');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('advanceOrCollide rejects (does not hang) when its replay commit blocks', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeRepo(dir);
      const git = simpleGit(root);
      const base = (await git.revparse(['HEAD'])).trim();
      // A work branch off base with a DISJOINT change → advanceOrCollide takes the replay/cherry-pick
      // path (which commits, so the pre-commit hook stalls it).
      const wt = path.join(root, 'wt');
      await git.raw('worktree', 'add', '--force', '-B', 'work', wt, base);
      const wtGit = simpleGit(wt);
      await ensureGitIdentity(wtGit);
      await fs.writeFile(path.join(wt, 'work.txt'), 'w\n');
      await wtGit.raw('add', '-A');
      await wtGit.commit('work');
      await git.raw('worktree', 'remove', '--force', wt);
      // Move canon forward on a disjoint path so HEAD != base → the cherry-pick branch runs clean.
      await fs.writeFile(path.join(root, 'README'), 'seed2\n');
      await git.raw('add', '-A');
      await git.commit('canon moves');
      await installBlockingCommitHooks(root);

      // advanceOrCollide's replay CATCHES a failed cherry-pick as a collision (abort + retry-signal);
      // a persistent hang makes the abort fail too → it throws. EITHER way the bounded git makes it
      // SETTLE (releasing the lock) instead of wedging. Pre-fix (raw simpleGit) it can't settle until
      // the hung op ends — past this budget → the TIMEOUT sentinel → fail.
      const settled = await within(
        advanceOrCollide(root, 'work', base, BLOCK_MS).then(() => 'settled' as const, () => 'settled' as const),
        SETTLE_BUDGET,
      );
      expect(settled).toBe('settled');
    } finally {
      await rmTempDir(dir);
    }
  });
});
