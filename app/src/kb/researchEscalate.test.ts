// Research depth-limit escalation (SPEC-0028 RESEARCH-11). Real FS temp dir (TEST-18); the review
// store + audit are plain file writes, so no git/SDK needed.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { raiseResearchEscalation, RESEARCH_DEPTH_REVIEW_KIND } from './researchEscalate';
import { readAllReviews } from './reviewStore';
import { CONTROL_AUDIT_REL } from './audit';
import type { ResearcherConfig, ResearchRequest } from './researchers';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

const web: ResearcherConfig = { id: 'web-1', label: 'Prior art', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true };
const request: ResearchRequest = { id: 'src.md:42', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose', sourceId: 'S1' }, what: 'Project Atlas', why: 'unknown term', context: 'launch', dedupKey: 'project atlas::S1', depth: 3 };

async function readAudit(root: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(path.join(root, CONTROL_AUDIT_REL), 'utf8');
    return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('raiseResearchEscalation (RESEARCH-11)', () => {
  it('raises a single yes/no "continue?" Review with the depth context + a resumable markerKey', async () => {
    await withTemp(async (root) => {
      const out = await raiseResearchEscalation(root, web, request, 3, () => '2026-06-02T01:00:00.000Z');
      expect(out.created).toBe(true);

      const reviews = await readAllReviews(root);
      expect(reviews).toHaveLength(1);
      const rev = reviews[0];
      expect(rev.id).toBe(out.reviewId);
      expect(rev.status).toBe('open');
      expect(rev.question).toMatch(/Continue researching .*Project Atlas/);
      expect(rev.detail).toMatch(/depth 3 \(limit 2\)/);
      expect(rev.raisedBy.stage).toBe('researcher');
      expect(rev.raisedBy.markerKey).toMatchObject({ kind: RESEARCH_DEPTH_REVIEW_KIND, requestId: 'src.md:42', researcherId: 'web-1', depth: '3', maxDepth: '2' });
      expect(rev.raisedBy.auditRel).toBe(CONTROL_AUDIT_REL); // where answerReview appends the resume marker
      expect(rev.subject.refs).toEqual(['Project Atlas']);
    });
  });

  it('audits the escalation (researcher/escalated, no secondary source) with the depth + reviewId', async () => {
    await withTemp(async (root) => {
      const out = await raiseResearchEscalation(root, web, request, 3, () => '2026-06-02T01:00:00.000Z');
      const ev = (await readAudit(root)).find((a) => a.eventType === 'escalated');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({ actor: 'researcher' });
      expect(ev!.subjects).toMatchObject({ researcherId: 'web-1', requestId: 'src.md:42', reviewId: out.reviewId });
      expect(ev!.payload).toMatchObject({ depth: 3, maxDepth: 2, escalatedToReview: true, egressTier: 'public-web' });
    });
  });

  it('is idempotent per requestId: a re-surfaced over-depth chain reuses its OPEN review (no duplicate, no re-audit)', async () => {
    await withTemp(async (root) => {
      const first = await raiseResearchEscalation(root, web, request, 3, () => '2026-06-02T01:00:00.000Z');
      const second = await raiseResearchEscalation(root, web, request, 4, () => '2026-06-02T02:00:00.000Z');
      expect(second.created).toBe(false);
      expect(second.reviewId).toBe(first.reviewId);
      expect(await readAllReviews(root)).toHaveLength(1); // not duplicated
      expect((await readAudit(root)).filter((a) => a.eventType === 'escalated')).toHaveLength(1); // only the first audited
    });
  });

  it('raises a distinct review for a different request', async () => {
    await withTemp(async (root) => {
      await raiseResearchEscalation(root, web, request, 3, () => '2026-06-02T01:00:00.000Z');
      await raiseResearchEscalation(root, web, { ...request, id: 'other.md:9', what: 'Orion' }, 3, () => '2026-06-02T01:05:00.000Z');
      const reviews = await readAllReviews(root);
      expect(reviews).toHaveLength(2);
      expect(new Set(reviews.map((r) => r.raisedBy.markerKey.requestId))).toEqual(new Set(['src.md:42', 'other.md:9']));
    });
  });
});
