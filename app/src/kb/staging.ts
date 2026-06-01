// Staging branch + promotion gate (SPEC-0021 STAGING) — realizes the SPEC-0019 evergreen
// invariant. Stages work on the `staging` branch; `main` is advanced ONLY by the promotion
// gate, which copies the evergreen path set (sources/ … ) staging→main. `main` therefore
// never contains working paths (inbox/, candidates/, queue/, reviews/) — by construction,
// not cleanup (CANON-1/2/8; STAGING-3/6). All canonical writes stay serialized by the shared
// stageLock Mutex (SPEC-0014 §5); these helpers are the ref-level mechanics under it.
import path from 'node:path';
import simpleGit from 'simple-git';
import { ensureGitIdentity } from './vault';

export const STAGING_BRANCH = 'staging';

/**
 * The evergreen path set promoted to `main` (STAGING-3). v1 promotes **sources only** — the one
 * kind that is resolved+valid the moment it exists (immutable ground truth, DATA-2). `entities/`,
 * `claims/`, `outputs/` join the set when their resolving stage (CONNECT, SPEC-0020) lands; until
 * then they live only on `staging` (CANON-10).
 */
export const EVERGREEN_PATHS = ['sources'] as const;

/** Ensure a long-lived `staging` branch exists, created off the vault's current branch (HEAD)
 *  if absent (STAGING-1). Created off HEAD — never a hardcoded `main`, so vaults whose default
 *  branch is `master` work too. staging is NOT checked out — the root worktree stays on its
 *  evergreen branch for Obsidian; stages run in their own worktrees. */
export async function ensureStagingBranch(root: string): Promise<void> {
  const git = simpleGit(path.resolve(root));
  await ensureGitIdentity(git);
  const branches = await git.branchLocal();
  if (!branches.all.includes(STAGING_BRANCH)) {
    await git.raw('branch', STAGING_BRANCH); // off current HEAD (branch-name agnostic)
  }
}

/** Advance `staging` to `ref` (a stage's committed work branch). Because `staging` is never
 *  checked out (stages live in worktrees on their own work branches), a force-update is the
 *  safe, simple way to move the ref (STAGING-2). */
export async function advanceStaging(root: string, ref: string): Promise<void> {
  await simpleGit(path.resolve(root)).raw('branch', '-f', STAGING_BRANCH, ref);
}

/**
 * The promotion gate (STAGING-3/4): advance `main` to hold the evergreen subset of `staging`.
 * Copy-the-evergreen-paths — bring each evergreen path from `staging` into the (main-checked-out)
 * root worktree and commit if anything changed. Working paths are never named, so `main` cannot
 * contain them. Idempotent: a no-op (returns false) when nothing evergreen changed.
 *
 * MUST be called serialized via the shared canonical-writer lock so it never races a stage's
 * ref advance. v1 covers append-only `sources/`; mirroring deletions (needed once `entities/`
 * joins the set and CONNECT merges/deletes) is a later concern (§8).
 */
export async function promote(root: string, paths: readonly string[] = EVERGREEN_PATHS): Promise<boolean> {
  root = path.resolve(root);
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  for (const p of paths) {
    try {
      await git.raw('checkout', STAGING_BRANCH, '--', p); // updates main's index+worktree for p
    } catch {
      /* path absent on staging (e.g. nothing archived yet) — nothing to promote for it */
    }
  }
  const status = await git.status();
  if (status.files.length === 0) return false; // idempotent: nothing evergreen changed
  await git.raw('add', '-A', ...paths);
  await git.commit('promote: evergreen → main');
  return true;
}
