// Approved-consolidation execution (SPEC-0024 REFLECT-5/7). Real FS + git: only an affirmatively-
// answered consolidation Review executes a merge (via the shared merge core), and the loser then
// promotes away from `main` via the deletion-aware gate.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createKb } from './vault';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { promote } from './staging';
import { reviewRel, writeReviewFile } from './reviewStore';
import { executeApprovedConsolidation } from './executeApprovedConsolidation';
import { ulid } from './ulid';
import type { Review, ReviewVerdict } from './reviews';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const CANON = 'entities/person/steve-jobs.md';
const LOSER = 'entities/person/steven-jobs.md';

/** A consolidation Review answered with `verdict`, with the merge plan in the markerKey. */
function consolidationReview(id: string, verdict: ReviewVerdict): Review {
  return {
    id,
    status: 'answered',
    question: 'Merge Steven Jobs into Steve Jobs?',
    detail: 'Same person.',
    raisedBy: {
      stage: 'job:reflect',
      runId: '01R',
      item: { kind: 'job', ref: '.kb/jobs/reflect/journal.jsonl' },
      auditRel: '.kb/jobs/reflect/journal.jsonl',
      markerKey: { jobId: 'reflect', kind: 'consolidation', canonicalRel: CANON, loserRels: LOSER },
    },
    subject: {},
    createdAt: '2026-06-02T00:00:00Z',
    answer: { verdict, answeredAt: '2026-06-02T01:00:00Z' },
  };
}

async function seedKB(stagingWt: string, reviewId: string, verdict: ReviewVerdict): Promise<void> {
  const node = (name: string) => `---\nid: ${name}\nkind: person\nname: ${name}\n---\n# ${name}\n`;
  await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
  await fs.writeFile(path.join(stagingWt, CANON), node('Steve Jobs'), 'utf8');
  await fs.writeFile(path.join(stagingWt, LOSER), node('Steven Jobs'), 'utf8');
  await fs.mkdir(path.join(stagingWt, 'claims', '2026'), { recursive: true });
  await fs.writeFile(path.join(stagingWt, 'claims/2026/01C.md'), `---\nid: 01C\nsubject: ${LOSER}\nstatus: fact\nconfidence: 0.9\n---\n\nCo-founded Apple.\n`, 'utf8');
  await writeReviewFile(path.join(stagingWt, reviewRel(reviewId)), consolidationReview(reviewId, verdict));
  const g = simpleGit(stagingWt);
  await g.add('-A');
  await g.commit('seed nodes + answered review');
}

async function withVault(fn: (root: string, stagingWt: string, lock: Mutex) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    const stagingWt = await ensureStagingWorktree(root);
    await fn(root, stagingWt, new Mutex());
  } finally {
    await rmTempDir(dir);
  }
}

describe.skipIf(!gitAvailable)('executeApprovedConsolidation (REFLECT-5/7)', () => {
  it('an APPROVED (confirm) consolidation merges the loser; promote removes it from main', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const id = ulid();
      await seedKB(stagingWt, id, 'confirm');
      const res = await executeApprovedConsolidation(stagingWt, id, lock);
      expect(res.executed).toBe(true);
      expect(res.deleted).toEqual([LOSER]);

      expect(await pathExists(path.join(stagingWt, LOSER))).toBe(false); // loser gone on staging
      const claimMd = await fs.readFile(path.join(stagingWt, 'claims/2026/01C.md'), 'utf8');
      expect(claimMd).toContain(`subject: ${CANON}`); // claim repointed to the survivor

      await promote(root); // deletion-aware gate mirrors the removal to main (REFLECT-7 / STAGING-10)
      expect(await pathExists(path.join(root, CANON))).toBe(true);
      expect(await pathExists(path.join(root, LOSER))).toBe(false); // loser removed from main
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('a REJECTED review executes NOTHING (safety: only explicit approval acts; REFLECT-5)', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const id = ulid();
      await seedKB(stagingWt, id, 'reject');
      const res = await executeApprovedConsolidation(stagingWt, id, lock);
      expect(res).toMatchObject({ executed: false, reason: 'not-approved' });
      expect(await pathExists(path.join(stagingWt, LOSER))).toBe(true); // loser untouched
    });
  });

  it('is idempotent: a second execution after the merge is a no-op', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const id = ulid();
      await seedKB(stagingWt, id, 'confirm');
      expect((await executeApprovedConsolidation(stagingWt, id, lock)).executed).toBe(true);
      const again = await executeApprovedConsolidation(stagingWt, id, lock);
      expect(again).toMatchObject({ executed: false, reason: 'already-merged' });
    });
  });

  it('a non-consolidation or missing review is a safe no-op', async () => {
    await withVault(async (root, stagingWt, lock) => {
      expect(await executeApprovedConsolidation(stagingWt, ulid(), lock)).toMatchObject({ executed: false, reason: 'not-found' });
    });
  });
});
