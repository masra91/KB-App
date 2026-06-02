// Lineage tracer (SPEC-0029 AUDIT-6). Traces a subject's provenance + transformations + decisions
// from the canonical audit. Real FS + git temp vaults (TEST-18).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { traceLineage } from './lineage';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

async function writeAudit(root: string, rel: string, lines: Record<string, unknown>[]): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/** A source S1 → entity E1 (claimed from S1, resolved by Connect) → with a review decision along the way. */
async function seedLineage(root: string): Promise<void> {
  await writeAudit(root, path.join('sources', '2026', '01', 'S1', 'audit.jsonl'), [
    { action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: { route: 'keep' }, agent: { via: 'deterministic' } },
    { ts: '2026-01-01T00:01:00.000Z', stage: 'decompose', runId: 'D1', sourceId: 'S1', event: 'decomposed', candidates: 1 },
    { ts: '2026-01-01T00:02:00.000Z', stage: 'claims', runId: 'C1', entityId: 'E1', sourceId: 'S1', event: 'awaiting-review', reviewIds: ['V1'] },
    { ts: '2026-01-01T00:03:00.000Z', stage: 'claims', event: 'review-answered', reviewId: 'V1', question: 'is this right?', verdict: 'confirm', entityId: 'E1' },
    { ts: '2026-01-01T00:04:00.000Z', stage: 'claims', runId: 'C2', entityId: 'E1', sourceId: 'S1', event: 'claimed', claims: 2 },
  ]);
  await writeAudit(root, path.join('connect', 'audit.jsonl'), [
    { ts: '2026-01-01T00:05:00.000Z', stage: 'connect', runId: 'N1', blockKey: 'person|atlas', event: 'resolved', node: 'entities/2026/01/E1.md', candidates: 1, merged: 0 },
  ]);
  // An unrelated source — must NOT leak into E1's lineage.
  await writeAudit(root, path.join('sources', '2026', '01', 'S2', 'audit.jsonl'), [
    { action: 'archived', id: 'S2', archivedAt: '2026-01-01T00:06:00.000Z', decision: {}, agent: { via: 'deterministic' } },
  ]);
}

describe.skipIf(!gitAvailable)('traceLineage (AUDIT-6)', () => {
  it('traces an entity: provenance source, transformation timeline, and decisions', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedLineage(root);

      const lin = await traceLineage(root, 'E1');
      expect(lin.kind).toBe('entity');
      expect(lin.sources).toEqual(['S1']); // provenance: where it came from
      // timeline is oldest-first and spans decompose → claims → connect, including the source archive.
      expect(lin.events.map((e) => `${e.actor}:${e.eventType}`)).toEqual([
        'archivist:archived',
        'decompose:decomposed',
        'claims:awaiting-review',
        'claims:review-answered',
        'claims:claimed',
        'connect:resolved',
      ]);
      // decisions surface the review (the why / human call).
      expect(lin.decisions.map((e) => e.eventType)).toEqual(['awaiting-review', 'review-answered']);
      expect(lin.decisions[1].payload.verdict).toBe('confirm');
      // the unrelated S2 archive is excluded.
      expect(lin.events.some((e) => e.subjects.sourceId === 'S2')).toBe(false);
    });
  });

  it('traces a source by its own id', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedLineage(root);
      const lin = await traceLineage(root, 'S1');
      expect(lin.kind).toBe('source');
      expect(lin.events.length).toBeGreaterThanOrEqual(2); // at least archived + decomposed
    });
  });

  it('an unknown id yields an empty lineage, not an error', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedLineage(root);
      const lin = await traceLineage(root, 'NOPE');
      expect(lin).toMatchObject({ subjectId: 'NOPE', kind: 'unknown', sources: [], events: [], decisions: [] });
    });
  });
});
