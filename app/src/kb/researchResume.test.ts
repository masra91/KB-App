// Resume-on-confirm for depth-escalation Reviews (SPEC-0028 RESEARCH-11, D7 fast-follow). Real FS+git
// temp vault (TEST-18); the cognition is injected (opts.researchFn) so no network/SDK. Proves the
// "Continue researching X?" control is NOT a dead affordance: confirm re-dispatches one level deeper,
// reject stops the chain, and it's a safe no-op for any non-research-depth review.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { upsertResearcher } from './researcherRegistry';
import { raiseResearchEscalation } from './researchEscalate';
import { resumeApprovedResearchEscalation } from './researchResume';
import { answerReview, writeReviewFile, reviewRel } from './reviewStore';
import { Mutex } from './stageLock';
import { ulid } from './ulid';
import type { ResearchFn } from './researchRun';
import type { Review } from './reviews';
import type { ResearcherConfig, ResearchRequest } from './researchers';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    await fn(root);
  } finally {
    await rmTempDir(dir);
  }
}

const web: ResearcherConfig = { id: 'web-1', label: 'Prior art', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true };
const request: ResearchRequest = { id: 'src.md:42', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose', sourceId: 'S1' }, what: 'Project Atlas', why: 'unknown term', context: 'launch', dedupKey: 'project atlas::S1', depth: 3 };

/** A cognition that records its calls + returns one finding. */
function recordingFn(): { fn: ResearchFn; calls: () => number } {
  let calls = 0;
  const fn: ResearchFn = async (_r, req) => {
    calls++;
    return { found: true, note: `deeper finding for ${req.what}`, citations: [], query: req.what };
  };
  return { fn, calls: () => calls };
}

describe.skipIf(!gitAvailable)('resumeApprovedResearchEscalation (RESEARCH-11 resume-on-confirm)', () => {
  it('CONFIRM re-dispatches the parked request one level deeper (the control actually continues)', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web);
      const { reviewId } = await raiseResearchEscalation(root, web, request, 3);
      await answerReview(root, new Mutex(), reviewId, { verdict: 'confirm' });

      const { fn, calls } = recordingFn();
      const res = await resumeApprovedResearchEscalation(root, reviewId, { researchFn: fn });
      expect(res.resumed).toBe(true);
      expect(calls()).toBe(1); // the research ACTUALLY re-ran (not a dead affordance)
      expect(res.sourceIds).toHaveLength(1);
    });
  });

  it('REJECT stops the chain — no re-dispatch', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web);
      const { reviewId } = await raiseResearchEscalation(root, web, request, 3);
      await answerReview(root, new Mutex(), reviewId, { verdict: 'reject' });

      const { fn, calls } = recordingFn();
      const res = await resumeApprovedResearchEscalation(root, reviewId, { researchFn: fn });
      expect(res.resumed).toBe(false);
      expect(res.reason).toBe('not-confirmed');
      expect(calls()).toBe(0); // nothing egressed
    });
  });

  it('is a no-op for an UNANSWERED research-depth review', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web);
      const { reviewId } = await raiseResearchEscalation(root, web, request, 3);
      const { fn, calls } = recordingFn();
      const res = await resumeApprovedResearchEscalation(root, reviewId, { researchFn: fn });
      expect(res).toMatchObject({ resumed: false, reason: 'unanswered' });
      expect(calls()).toBe(0);
    });
  });

  it('is a safe no-op for a NON-research review (self-gating — safe to call for every answer)', async () => {
    await withVault(async (root) => {
      // A plain confirmed review with a different markerKey kind.
      const id = ulid();
      const other: Review = {
        id, status: 'answered', question: 'Merge A into B?', detail: 'x',
        raisedBy: { stage: 'job:reflect', runId: id, item: { kind: 'job', ref: 'x' }, auditRel: '.kb/audit.jsonl', markerKey: { kind: 'consolidation' } },
        subject: {}, createdAt: '2026-06-02T00:00:00.000Z', answer: { verdict: 'confirm', answeredAt: '2026-06-02T01:00:00.000Z' },
      };
      await writeReviewFile(path.join(root, reviewRel(id)), other);
      const { fn, calls } = recordingFn();
      const res = await resumeApprovedResearchEscalation(root, id, { researchFn: fn });
      expect(res).toMatchObject({ resumed: false, reason: 'not-a-research-review' });
      expect(calls()).toBe(0);
    });
  });
});
