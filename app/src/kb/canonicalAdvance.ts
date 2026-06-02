// Optimistic-concurrency canonical advance (SPEC-0014 ORCH-17/18/19). The shared writer lock used
// to guard a stage's WHOLE per-item cycle (sync → cognition → write → commit → ff-advance). This
// narrows it to ONLY the canonical ff-advance: a stage prepares its commit OFF a synced checkpoint
// outside the lock (ORCH-17), then advances UNDER the lock (ORCH-18). Conflict-freedom rides on
// globally-unique ULID write paths (ORCH-6): items almost always touch disjoint paths, so a moved
// canonical is reconciled by REPLAYING the item commit (cherry-pick) — no merge bubble, linear
// history (ORCH-3). The rare same-path collision (e.g. two Connect items resolving the same block)
// is detected and retried against the fresh canonical, bounded → set-aside (ORCH-19).
import path from 'node:path';
import { promises as fs } from 'node:fs';
import simpleGit from 'simple-git';
import { Mutex } from './stageLock';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';

/** Default same-path collision retries before an item is set aside (ORCH-19). */
export const DEFAULT_MAX_COLLISION_RETRIES = 3;

/** Default per-stage concurrency cap (ORCH-20). cap=1 ⇒ the serial drain (output-identical to the
 *  pre-concurrency engine); a higher cap lets a stage run that many items' cognition at once,
 *  their advances still serialized by the shared lock. Raised deliberately by pipeline.ts. */
export const DEFAULT_STAGE_CAP = 1;

/**
 * Run `fn` against a FRESH, isolated git worktree for ONE in-flight item (ORCH-17/20): a unique
 * work branch `kb/<stage>-work-<ulid>` checked out off `checkpoint`, torn down afterward. This is
 * what lets a stage run cap>1 items concurrently — each prepares in its own worktree+branch instead
 * of clobbering a single shared one. The teardown is best-effort + prune-guarded so a crash mid-item
 * can't leak a worktree (a `worktree prune` on the next call reaps any orphan).
 */
export async function withEphemeralWorktree<T>(
  root: string,
  stage: string,
  checkpoint: string,
  fn: (ctx: { wt: string; workBranch: string }) => Promise<T>,
): Promise<T> {
  root = path.resolve(root);
  const id = ulid();
  const workBranch = `kb/${stage}-work-${id}`;
  const wt = path.join(root, '.kb', 'cache', 'worktrees', `${stage}-${id}`);
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  await git.raw('worktree', 'prune'); // reap any orphan from a prior crash before adding
  await fs.mkdir(path.dirname(wt), { recursive: true });
  await git.raw('worktree', 'add', '--force', '-B', workBranch, wt, checkpoint);
  try {
    return await fn({ wt, workBranch });
  } finally {
    await git.raw('worktree', 'remove', '--force', wt).catch(() => {});
    await git.raw('branch', '-D', workBranch).catch(() => {});
    await git.raw('worktree', 'prune').catch(() => {});
  }
}

/** Read the canonical worktree's current HEAD commit — the checkpoint a stage prepares off. */
export async function canonicalHead(root: string): Promise<string> {
  return (await simpleGit(root).revparse(['HEAD'])).trim();
}

export type AdvanceOutcome = 'advanced' | 'collision';

/**
 * Advance the canonical branch to include the work committed on `workBranch` (prepared off `base`).
 * MUST be called inside `lock.run(...)` — this is the ONLY region the canonical-writer lock guards
 * (ORCH-18). Three cases:
 *  - canonical HEAD === `base` (unchanged) → fast-forward (the common, cap=1 path);
 *  - canonical moved, item paths DISJOINT → cherry-pick (replay) `base..workBranch` onto HEAD;
 *  - same-path collision (cherry-pick conflicts) → abort and return `'collision'` (caller re-syncs
 *    + retries the item against the new canonical).
 * Either way canonical history stays LINEAR (ff or replayed commits, never a merge; ORCH-3).
 *
 * Runs in the canonical worktree (`root`), which is clean + on the canonical branch (stages commit
 * in their own disposable worktrees, never here).
 */
export async function advanceOrCollide(root: string, workBranch: string, base: string): Promise<AdvanceOutcome> {
  const git = simpleGit(root);
  const head = (await git.revparse(['HEAD'])).trim();
  if (head === base) {
    await git.raw('merge', '--ff-only', workBranch); // base unchanged → clean fast-forward
    return 'advanced';
  }
  // Canonical moved since the checkpoint — replay the item's commits onto the new HEAD.
  try {
    await git.raw('cherry-pick', `${base}..${workBranch}`);
    return 'advanced';
  } catch {
    // Same-path collision: abort to leave the canonical untouched, then signal a retry. A FAILED
    // abort would leave the sole canonical worktree mid-cherry-pick (dirty) — surface it, never
    // swallow, so the stage stops rather than advancing on a corrupt tree (QA #45 note).
    try {
      await git.raw('cherry-pick', '--abort');
    } catch (abortErr) {
      throw new Error(
        `canonicalAdvance: cherry-pick conflict could not be aborted — canonical worktree may be left dirty: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
      );
    }
    return 'collision';
  }
}

export interface OptimisticAdvanceOptions {
  /** Canonical worktree (on the canonical branch). */
  root: string;
  /** The shared per-vault canonical-writer lock (§5). Only the advance runs under it. */
  lock: Mutex;
  /** The stage's work branch (e.g. `kb/decompose-work`) holding the prepared commit. */
  workBranch: string;
  /** Same-path collision retries before set-aside (ORCH-19). Defaults to DEFAULT_MAX_COLLISION_RETRIES. */
  maxCollisionRetries?: number;
}

export type OptimisticAdvanceResult = 'advanced' | 'noop' | 'setaside';

/**
 * Drive one item through optimistic concurrency (ORCH-17/18/19):
 *  1. read the canonical checkpoint `base`;
 *  2. `prepare(base)` OFF the lock — sync a worktree to `base`, run cognition, write, commit on
 *     `workBranch`; returns `true` if it committed work to advance, `false` for a no-op (e.g. the
 *     item turned out already-terminal / nothing to write);
 *  3. advance UNDER the lock via `advanceOrCollide`.
 * A same-path collision re-runs from step 1 against the fresh canonical, bounded to K retries; on
 * exhaustion `onExhausted()` records the set-aside (ORCH-19) — the item is never dropped or
 * half-applied. When this item is the only writer between its prepare and advance the advance is a
 * fast-forward; but even with a stage's own drain serial (cap=1), CROSS-STAGE concurrency (or
 * cap>1) can move the canonical in that window, exercising the replay/collision paths. Either way
 * the canonical state is the same — linear history (ORCH-3), only the interleaving differs.
 */
export async function withOptimisticAdvance(
  opts: OptimisticAdvanceOptions,
  prepare: (base: string) => Promise<boolean>,
  onExhausted: () => Promise<void>,
): Promise<OptimisticAdvanceResult> {
  const maxRetries = opts.maxCollisionRetries ?? DEFAULT_MAX_COLLISION_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const base = await canonicalHead(opts.root);
    const committed = await prepare(base);
    if (!committed) return 'noop';
    const outcome = await opts.lock.run(() => advanceOrCollide(opts.root, opts.workBranch, base));
    if (outcome === 'advanced') return 'advanced';
    // 'collision' → re-sync to the moved canonical and retry the whole item.
  }
  await onExhausted();
  return 'setaside';
}

export interface ConcurrentAdvanceOptions {
  /** Canonical worktree (on the canonical branch). */
  root: string;
  /** The shared per-vault canonical-writer lock (§5). Only the advance runs under it. */
  lock: Mutex;
  /** Stage name (e.g. `decompose`) — namespaces the per-item ephemeral work branch + worktree. */
  stage: string;
  /** Same-path collision retries before set-aside (ORCH-19). Defaults to DEFAULT_MAX_COLLISION_RETRIES. */
  maxCollisionRetries?: number;
}

/** Context handed to a `prepare` callback under {@link withConcurrentAdvance}: its PRIVATE ephemeral
 *  worktree (fresh off `base`, on a per-item branch) and the checkpoint it was created off. The
 *  callback writes its effects in `wt` and commits there; it does NOT manage the worktree or advance. */
export interface PrepareContext {
  wt: string;
  base: string;
}

/**
 * Like {@link withOptimisticAdvance}, but for stages that run **cap>1 items concurrently** (ORCH-20):
 * each attempt gets a FRESH ephemeral per-item worktree off the checkpoint (via
 * {@link withEphemeralWorktree}), so concurrent prepares within a stage never clobber a shared
 * worktree. `prepare({ wt, base })` runs OFF the lock (cognition + writes + commit in `wt`); the
 * advance runs UNDER the lock via the SAME {@link advanceOrCollide} primitive (ff / disjoint replay /
 * same-path collision → bounded retry → set-aside). cap=1 ⇒ one ephemeral worktree at a time, output-
 * identical to the serial drain. (`withOptimisticAdvance` — caller-managed fixed worktree/branch —
 * stays for JOBS's per-job persistent-worktree model; both share `advanceOrCollide`.)
 */
export async function withConcurrentAdvance(
  opts: ConcurrentAdvanceOptions,
  prepare: (ctx: PrepareContext) => Promise<boolean>,
  onExhausted: () => Promise<void>,
): Promise<OptimisticAdvanceResult> {
  const maxRetries = opts.maxCollisionRetries ?? DEFAULT_MAX_COLLISION_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const base = await canonicalHead(opts.root);
    const outcome = await withEphemeralWorktree(opts.root, opts.stage, base, async ({ wt, workBranch }) => {
      const committed = await prepare({ wt, base });
      if (!committed) return 'noop' as const;
      return opts.lock.run(() => advanceOrCollide(opts.root, workBranch, base));
    });
    if (outcome === 'noop') return 'noop';
    if (outcome === 'advanced') return 'advanced';
    // 'collision' → retry the whole item in a fresh worktree against the moved canonical.
  }
  await onExhausted();
  return 'setaside';
}
