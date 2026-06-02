// Regression gate for #163 CLASS COMPLETION: beyond #176's hot-path cure (advanceOrCollide +
// promote), EVERY git write op that runs under the canonical-writer lock must be time-bounded, so a
// blocked op throws → the section's `finally` releases the lock → #170's watchdog surfaces it,
// instead of holding the lock forever (the #163 mechanism). The follow-up routes all such sites
// through `boundedGit`; this gate proves the pattern holds for a representative AUTONOMOUS caller
// (`captureToInbox`, orchestrator-driven) AND a CONTROL-PLANE caller (`commitControlFile`, the
// shared Control-Panel committer) — KB-QD's bar. The other converted sites (normalizeInbox, linkOne,
// dedupClaimsOnce, purgeResetPromote, saveRecallOutput) share the identical `boundedGit` client.
//
// Fails-before/passes-after: revert the site to raw `simpleGit` and the blocked commit hangs past
// the budget → fail.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from './vault';
import { captureToInbox } from './ingest';
import { commitControlFile } from '../main/pipeline';
import { Mutex } from './stageLock';

const BLOCK_MS = 500;
const SETTLE_BUDGET = 2500;

const TIMEOUT = Symbol('did-not-settle');
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), ms))]);
}

async function installBlockingPreCommitHook(root: string): Promise<void> {
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nsleep 5\n', 'utf8');
  await fs.chmod(hook, 0o755);
}

async function makeRepo(dir: string): Promise<string> {
  const root = path.join(dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const git = simpleGit(root);
  await git.init(['--initial-branch=main']);
  await ensureGitIdentity(git);
  await fs.writeFile(path.join(root, 'README'), 'seed\n');
  await git.raw('add', '-A');
  await git.commit('seed');
  return root;
}

describe.skipIf(!gitAvailable)('#163 — every canonical-writer-held git op is time-bounded (class completion)', () => {
  it('AUTONOMOUS: captureToInbox rejects (does not hang) when its commit blocks, releasing the lock', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeRepo(dir);
      await installBlockingPreCommitHook(root);
      const lock = new Mutex();
      // captureToInbox runs under the canonical-writer lock (orchestrator). With the fix the blocked
      // commit is bounded → rejects → `finally` releases; pre-fix (raw simpleGit) it would hang.
      const capturing = lock.run(
        () => captureToInbox(root, 'test', [{ kind: 'text', text: 'hi' }], 123, { timeoutMs: BLOCK_MS }),
        'capture',
      );
      const outcome = await within(capturing.then(() => 'resolved' as const, () => 'rejected' as const), SETTLE_BUDGET);
      expect(outcome).toBe('rejected');
      const after = await within(lock.run(async () => 'ran', 'after'), SETTLE_BUDGET);
      expect(after).toBe('ran');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('CONTROL-PLANE: commitControlFile rejects (does not hang) when its commit blocks, releasing the lock', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeRepo(dir);
      // A tracked control file to commit (the shape of .kb/instance.json / jobs/registry.json).
      const ctl = path.join(root, '.kb', 'instance.json');
      await fs.mkdir(path.dirname(ctl), { recursive: true });
      await fs.writeFile(ctl, '{"v":1}\n');
      await installBlockingPreCommitHook(root);
      const lock = new Mutex();
      const committing = lock.run(() => commitControlFile(root, ctl, 'test change', BLOCK_MS), 'control');
      const outcome = await within(committing.then(() => 'resolved' as const, () => 'rejected' as const), SETTLE_BUDGET);
      expect(outcome).toBe('rejected');
      const after = await within(lock.run(async () => 'ran', 'after'), SETTLE_BUDGET);
      expect(after).toBe('ran');
    } finally {
      await rmTempDir(dir);
    }
  });
});
