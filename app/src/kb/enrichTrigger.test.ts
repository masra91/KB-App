// SPEC-0028 RESEARCH-3 / WS-B — the enrichment trigger: sparse ("little reference") entities emit a
// `research-request` the dispatcher can pick up; well-corroborated entities don't; and re-sweeping is
// idempotent (no re-emit, no audit bloat). Fails-before/passes-after the producer existed. Pure FS.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { renderEntityNode, entityFileRel, type EntityNode } from './connectDoc';
import { collectResearchRequests } from './researchInline';
import { dedupKeyFor } from './researchers';
import { flagSparseEntities, isSparseEntity, SPARSE_SOURCE_MAX } from './enrichTrigger';

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

const node = (over: Partial<EntityNode> & Pick<EntityNode, 'id' | 'name' | 'kind' | 'derivedFrom'>): EntityNode => ({
  confidence: 0.9,
  aliases: [over.id],
  resolvedFrom: [],
  tags: [`type/${over.kind}`],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
  ...over,
});

/** Write an entity node markdown under `entities/<kind>/<Name>.md` (the real Connect layout). */
async function writeEntity(root: string, n: EntityNode): Promise<void> {
  const rel = entityFileRel(n.kind, n.name, n.id);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, renderEntityNode(n), 'utf8');
}

const TS = '2026-06-02T00:00:00.000Z';

describe('isSparseEntity (WS-B)', () => {
  it('flags an entity with <= SPARSE_SOURCE_MAX sources, not one above it', () => {
    expect(isSparseEntity({ derivedFrom: ['s1'] })).toBe(true); // single-source = little reference
    expect(isSparseEntity({ derivedFrom: [] })).toBe(true);
    expect(isSparseEntity({ derivedFrom: ['s1', 's2'] })).toBe(false); // corroborated
    expect(SPARSE_SOURCE_MAX).toBe(1);
  });
});

describe('flagSparseEntities (WS-B) — the missing research-request producer', () => {
  it('emits a research-request for a sparse entity, none for a well-corroborated one', async () => {
    await withRoot(async (root) => {
      await writeEntity(root, node({ id: 'E_SPARSE', name: 'Black Lotus', kind: 'artifact', derivedFrom: ['sources/ab/01'] }));
      await writeEntity(root, node({ id: 'E_RICH', name: 'Richard Garfield', kind: 'person', derivedFrom: ['sources/ab/01', 'sources/cd/02'] }));

      const emitted = await flagSparseEntities(root, new Set(), { ts: TS });
      expect(emitted).toBe(1); // only the sparse entity

      // The emitted signal is readable back as a dispatchable ResearchRequest (the existing collect path).
      const reqs = await collectResearchRequests(root);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ what: 'Black Lotus', by: { stage: 'enrich', entityId: 'E_SPARSE' } });
      expect(reqs[0].dedupKey).toBe(dedupKeyFor({ what: 'Black Lotus', by: { entityId: 'E_SPARSE' } }));
      expect(reqs[0].why).toMatch(/sparse entity/i);
    });
  });

  it('is idempotent — skips an entity already carrying a pending request (no re-emit)', async () => {
    await withRoot(async (root) => {
      await writeEntity(root, node({ id: 'E1', name: 'Time Walk', kind: 'artifact', derivedFrom: ['sources/ab/01'] }));

      expect(await flagSparseEntities(root, new Set(), { ts: TS })).toBe(1);
      // Second sweep passes the now-pending dedupKeys (what runInlineResearchSweep does) → no re-emit.
      const pending = new Set((await collectResearchRequests(root)).map((r) => r.dedupKey));
      expect(await flagSparseEntities(root, pending, { ts: TS })).toBe(0);
      expect(await collectResearchRequests(root)).toHaveLength(1); // still one — audit not bloated
    });
  });

  it('skips a malformed/foreign node without crashing the sweep (ENG-16 isolation)', async () => {
    await withRoot(async (root) => {
      await writeEntity(root, node({ id: 'E_OK', name: 'Mox Sapphire', kind: 'artifact', derivedFrom: ['sources/ab/01'] }));
      // A junk .md with no id/kind/name — parseEntityNode throws; the scan must skip it.
      const junk = path.join(root, 'entities', 'artifact', 'broken.md');
      await fs.mkdir(path.dirname(junk), { recursive: true });
      await fs.writeFile(junk, '# not an entity node\n', 'utf8');

      const emitted = await flagSparseEntities(root, new Set(), { ts: TS });
      expect(emitted).toBe(1); // only the well-formed sparse entity
    });
  });

  it('is a no-op on a vault with no entities/ tree', async () => {
    await withRoot(async (root) => {
      await fs.mkdir(root, { recursive: true });
      expect(await flagSparseEntities(root, new Set(), { ts: TS })).toBe(0);
    });
  });
});
