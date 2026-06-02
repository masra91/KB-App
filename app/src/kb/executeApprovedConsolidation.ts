// Execute a Principal-APPROVED Reflect consolidation (SPEC-0024 REFLECT-5/7) — the testable core
// the main-process `answerActiveReview` dispatches to (thin glue). Reflect only ever PROPOSES a
// merge (a destructive→Review finding, slice 1); the actual merge runs ONLY when the Principal
// answers that Review with an explicit affirmative verdict — never autonomously. The merge reuses
// the shared entity-merge core (`mergeNodes`) and advances the canonical under the shared lock via
// the optimistic-advance helper; the caller promotes (the loser's deletion mirrors to `main` via
// the deletion-aware gate, STAGING-10). Idempotent: an already-merged plan is a clean no-op.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';
import { Mutex } from './stageLock';
import { withOptimisticAdvance } from './canonicalAdvance';
import { getReview } from './reviewStore';
import { mergeNodes } from './mergeNodes';

const WORKTREE_REL = path.join('.kb', 'cache', 'worktrees', 'consolidation');
const WORK_BRANCH = 'kb/consolidation-work';
/** Per-job consolidation audit (tracked on staging, never promoted — like the job journal). */
function consolidationAuditRel(jobId: string): string {
  return path.join('.kb', 'jobs', jobId, 'consolidations.jsonl');
}

export interface ConsolidationResult {
  reviewId: string;
  executed: boolean;
  /** Why it didn't execute (when `executed` is false). */
  reason?: 'not-found' | 'not-approved' | 'not-a-consolidation' | 'already-merged';
  deleted?: string[]; // loser node rels removed (when executed)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorktree(root: string): Promise<string> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  const branch = (await git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const wt = path.join(root, WORKTREE_REL);
  try {
    await git.raw('worktree', 'prune');
  } catch {
    /* none yet */
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
    await git.raw('worktree', 'add', '-B', WORK_BRANCH, wt, branch);
  }
  return wt;
}

/**
 * Execute the consolidation a Review (`reviewId`) describes — but ONLY if it is an affirmatively-
 * answered (`verdict === 'confirm'`) consolidation Review (its merge plan rides in the markerKey).
 * Any other state (not found / not approved / not a consolidation / already merged) is a safe no-op
 * with a `reason`. MUST be called on the staging worktree; serializes its canonical advance through
 * `lock`. Returns what (if anything) it merged — the caller then promotes to mirror the deletion.
 */
export async function executeApprovedConsolidation(stagingWt: string, reviewId: string, lock: Mutex): Promise<ConsolidationResult> {
  stagingWt = path.resolve(stagingWt);
  const review = await getReview(stagingWt, reviewId);
  if (!review) return { reviewId, executed: false, reason: 'not-found' };
  // Safety envelope (REFLECT-5): nothing executes without an explicit affirmative answer.
  if (review.answer?.verdict !== 'confirm') return { reviewId, executed: false, reason: 'not-approved' };
  const mk = review.raisedBy.markerKey;
  if (mk.kind !== 'consolidation' || !mk.canonicalRel || !mk.loserRels) return { reviewId, executed: false, reason: 'not-a-consolidation' };
  const canonicalRel = mk.canonicalRel;
  const loserRels = mk.loserRels.split('\n').filter((r) => r.length > 0);
  const jobId = mk.jobId ?? 'reflect';
  const runId = ulid();

  let result: ConsolidationResult = { reviewId, executed: false, reason: 'already-merged' };

  const prepare = async (base: string): Promise<boolean> => {
    const wt = await ensureWorktree(stagingWt);
    const wtGit = simpleGit(wt);
    await wtGit.raw('reset', '--hard', base);
    const { deleted } = await mergeNodes(wt, canonicalRel, loserRels);
    if (deleted.length === 0) {
      result = { reviewId, executed: false, reason: 'already-merged' }; // idempotent: nothing to do
      return false;
    }
    // Rich audit (AUTO-8 / AUDIT-2,11): what merged into what + the approving reviewId (the why).
    const auditPath = path.join(wt, consolidationAuditRel(jobId));
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(
      auditPath,
      JSON.stringify({ ts: new Date().toISOString(), runId, event: 'consolidated', reviewId, canonicalRel, merged: deleted }) + '\n',
      'utf8',
    );
    await wtGit.raw('add', '-A');
    await wtGit.commit(`reflect: consolidate ${deleted.length} into ${canonicalRel} (review ${reviewId})`);
    result = { reviewId, executed: true, deleted };
    return true;
  };
  // A same-path collision exhaustion leaves the canonical untouched (no half-merge); the Principal's
  // approval persists on the Review, so a later poke/dispatch can retry. Rare (single canonical write).
  const onExhausted = async (): Promise<void> => {
    result = { reviewId, executed: false, reason: 'already-merged' };
  };

  await withOptimisticAdvance({ root: stagingWt, lock, workBranch: WORK_BRANCH }, prepare, onExhausted);
  return result;
}
