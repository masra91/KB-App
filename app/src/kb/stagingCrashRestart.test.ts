// Dedicated crash/restart safety tests for the staging promotion gate (SPEC-0021 STAGING-8;
// also exercises the STAGING-9 sweep backstop). Real git against a throwaway temp vault (TEST-18).
//
// STAGING-8: promotion + stage advances are restartable / crash-safe — BRANCH STATE is the source
// of truth, and a re-run re-promotes idempotently without duplicating `main` history divergently.
// We model three distinct crash points and assert each restarts cleanly:
//   1. crash AFTER a stage advanced `staging` but BEFORE the post-drain promotion ran;
//   2. crash MID-promote (main worktree updated from staging, but the commit never landed);
//   3. crash DURING an orchestrator's promotion — restart recovers main and never re-archives.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { createKb, ensureGitIdentity } from './vault';
import { ensureStagingBranch, advanceStaging, promote, STAGING_BRANCH } from './staging';
import { Orchestrator } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { findSourceDirs } from './decomposeStage';

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

/** Commit `files` onto `staging` via a throwaway worktree + advance staging — the way a stage's
 *  ff-advance leaves committed work on `staging` (the root is never on staging). */
async function commitOnStaging(root: string, files: Record<string, string>): Promise<void> {
  const wt = path.join(root, '.kb', 'cache', 'test-staging-wt');
  const git = simpleGit(root);
  await git.raw('worktree', 'add', '--force', wt, STAGING_BRANCH);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), content, 'utf8');
  }
  const wtGit = simpleGit(wt);
  await ensureGitIdentity(wtGit);
  await wtGit.raw('add', '-A');
  await wtGit.commit('staging work');
  const head = (await wtGit.revparse(['HEAD'])).trim();
  await git.raw('worktree', 'remove', '--force', wt);
  await advanceStaging(root, head);
}

const headCount = async (root: string): Promise<number> =>
  Number((await simpleGit(root).raw('rev-list', '--count', 'HEAD')).trim());

describe.skipIf(!gitAvailable)('staging crash/restart safety (SPEC-0021 STAGING-8)', () => {
  it('recovers a missed post-drain promotion on restart — branch state is the source of truth', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      // A stage advanced `staging` with an evergreen source, then the process crashed BEFORE the
      // afterDrain promotion ran: `staging` is ahead, `main` is behind.
      await commitOnStaging(root, { 'sources/2026/05/31/A/source.md': 'ground truth' });
      expect(await pathExists(path.join(root, 'sources/2026/05/31/A/source.md'))).toBe(false);

      // Restart: the next drain's afterDrain — or the periodic sweep (STAGING-9) — re-runs promote().
      expect(await promote(root)).toBe(true); // the missed promotion is recovered from branch state
      expect(await pathExists(path.join(root, 'sources/2026/05/31/A/source.md'))).toBe(true);
      expect((await simpleGit(root).status()).isClean()).toBe(true);

      // Idempotent backstop: a further sweep re-promotes to a no-op — no divergent/duplicate history.
      expect(await promote(root)).toBe(false);
    });
  });

  it('a crash MID-promote leaves no half-promote: restart converges main with exactly one commit', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      await commitOnStaging(root, { 'sources/2026/05/31/A/source.md': 'ground truth' });
      const git = simpleGit(root);
      const before = await headCount(root);

      // Simulate a crash AFTER promote()'s `git checkout staging -- sources` updated main's
      // index + worktree, but BEFORE the commit landed: main is dirty with the staged source.
      await git.raw('checkout', STAGING_BRANCH, '--', 'sources');
      expect((await git.status()).isClean()).toBe(false); // half-promoted, uncommitted

      // Restart: promote() re-runs idempotently from the same staging state and completes the commit.
      expect(await promote(root)).toBe(true);
      expect((await git.status()).isClean()).toBe(true);
      expect(await pathExists(path.join(root, 'sources/2026/05/31/A/source.md'))).toBe(true);

      // Exactly ONE promote commit was added — no divergent/duplicated main history (STAGING-8).
      expect((await headCount(root)) - before).toBe(1);
      expect(await promote(root)).toBe(false); // converged + idempotent
    });
  });

  it('orchestrator restart after a crashed promotion recovers main and does NOT re-archive (ORCH-13)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);

      // Orchestrator A archives the captured source onto `staging`, but its afterDrain promotion crashes.
      let crashed = false;
      const orchA = new Orchestrator(stagingWt, deterministicDecider, new Mutex(), async () => {
        crashed = true;
        throw new Error('simulated crash during promotion');
      });
      await orchA.capture('test', [{ kind: 'text', text: 'ground truth' }]);
      await orchA.poke().catch(() => {}); // the crash propagates out of the drain
      orchA.stop();
      expect(crashed).toBe(true);
      // The source is committed on `staging` (archived) but NOT on `main` (promotion crashed).
      expect((await findSourceDirs(stagingWt)).length).toBe(1);
      expect((await findSourceDirs(root)).length).toBe(0);

      // Restart: a fresh orchestrator + lock on the SAME vault. Its first drain re-promotes via
      // afterDrain and does NOT re-archive the already-committed source (commit-to-dequeue, ORCH-13).
      const orchB = new Orchestrator(stagingWt, deterministicDecider, new Mutex(), async () => {
        await promote(root);
      });
      await orchB.poke();
      orchB.stop();
      expect((await findSourceDirs(root)).length).toBe(1); // missed promotion recovered
      expect((await findSourceDirs(stagingWt)).length).toBe(1); // exactly one — not double-archived
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });
});
