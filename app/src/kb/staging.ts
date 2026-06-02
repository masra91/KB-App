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
 * The active evergreen path set promoted to `main` — the single source of truth for what reaches
 * `main` (STAGING-3/11). It **grows with its producers**: `sources/` is evergreen the moment it
 * exists (immutable ground truth, DATA-2); `entities/` + `claims/` join now that CONNECT
 * (SPEC-0020) resolves candidates into born-resolved nodes on `staging` and Claims attaches to
 * them — evergreen once resolved (CANON-10). `outputs/` joins when the Research/Query stage that
 * writes it lands. Working paths (`inbox/`, `candidates/`, `queue/`, `reviews/`) are never listed,
 * so `main` can never hold them (STAGING-6).
 */
export const EVERGREEN_PATHS = ['sources', 'entities', 'claims'] as const;

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
 * The promotion gate (STAGING-3/4), **deletion-aware** (STAGING-10): advance `main` to be an
 * EXACT MIRROR of `staging`'s evergreen subset — adds, edits, AND removals. For each evergreen
 * path, **clear `main`'s copy then restore `staging`'s** (index + worktree). Clearing first is
 * what makes `main` mirror DELETIONS: a node CONNECT merged away on `staging` (a deleted loser +
 * its repointed claims, SPEC-0020 §3 / CONNECT-10,11) leaves `main` too, so a deduped duplicate
 * never lingers — plain `checkout staging -- P` only adds/updates, never removes. `sources/` is
 * append-only, so mirroring never removes ground truth. Working paths are never named, so `main`
 * cannot contain them (STAGING-6). Idempotent: a no-op (returns false) when nothing evergreen
 * changed.
 *
 * MUST be called serialized via the shared canonical-writer lock so it never races a stage's
 * ref advance.
 */
export async function promote(root: string, paths: readonly string[] = EVERGREEN_PATHS): Promise<boolean> {
  root = path.resolve(root);
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  for (const p of paths) {
    // Drop main's current tracked copy of P (worktree + index). `--ignore-unmatch` makes a
    // never-yet-promoted path a no-op rather than an error — so an absent `entities/`/`claims/`
    // doesn't crash promotion (and lets the path stay absent if staging has none).
    await git.raw('rm', '-r', '-f', '--ignore-unmatch', '--quiet', '--', p).catch(() => {});
    try {
      await git.raw('checkout', STAGING_BRANCH, '--', p); // restore staging's P (index + worktree)
    } catch {
      /* P absent on staging — nothing to publish; it correctly stays removed from main */
    }
  }
  const status = await git.status();
  if (status.files.length === 0) return false; // idempotent: nothing evergreen changed
  await git.commit('promote: evergreen → main'); // commits the staged add/update/delete set
  return true;
}
