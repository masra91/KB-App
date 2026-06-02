// The persistent `staging` worktree (SPEC-0021): a checkout of the `staging` branch under
// `.kb/cache/worktrees/staging` where the WHOLE working pipeline runs (capture, archive,
// decompose, claims). The vault ROOT stays on its evergreen branch (main) for Obsidian; the
// stages operate on this worktree, advancing `staging` via their existing ff-merge logic
// (they're root-agnostic — they advance whatever branch their root is on). The promotion gate
// (staging.ts `promote`) copies the evergreen path set from `staging` back to the vault root.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import simpleGit from 'simple-git';
import { ensureGitIdentity } from './vault';
import { ensureStagingBranch, STAGING_BRANCH } from './staging';

const STAGING_WT_REL = path.join('.kb', 'cache', 'worktrees', 'staging');

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the persistent staging worktree exists and is a healthy checkout of `staging`
 * (creating the branch + worktree if absent), and return its absolute path. The pipeline uses
 * this path as its operational "root", so every stage reads/writes `staging`. Idempotent +
 * self-healing (recreates a broken/missing worktree), mirroring each stage's own worktree
 * lifecycle (SPEC-0014). Lives under the gitignored `.kb/cache/` so it never shows in `main`.
 */
export async function ensureStagingWorktree(vaultRoot: string): Promise<string> {
  vaultRoot = path.resolve(vaultRoot);
  await ensureStagingBranch(vaultRoot);
  const git = simpleGit(vaultRoot);
  await ensureGitIdentity(git);
  const wt = path.join(vaultRoot, STAGING_WT_REL);
  try {
    await git.raw('worktree', 'prune');
  } catch {
    /* none registered yet */
  }
  const healthy =
    (await pathExists(wt)) &&
    (await simpleGit(wt)
      .revparse(['--is-inside-work-tree'])
      .then(() => true)
      .catch(() => false));
  if (!healthy) {
    if (await pathExists(wt)) await fs.rm(wt, { recursive: true, force: true });
    await fs.mkdir(path.dirname(wt), { recursive: true });
    await git.raw('worktree', 'add', wt, STAGING_BRANCH); // checks out `staging` here
  }
  return wt;
}
