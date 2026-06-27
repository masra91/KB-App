// SPEC-0028 RESEARCH-3 / WS-B + RESEARCH-QUALITY — the enrichment trigger: entities that WANT enrichment
// (sparse by count OR facet-thin) emit a `research-request` the dispatcher can pick up; a well-corroborated
// AND facet-rich entity doesn't; and re-sweeping is idempotent (no re-emit, no audit bloat). Fails-before/
// passes-after the producer existed + the qualitative-gap broadening. Pure FS.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { renderEntityNode, entityFileRel, type EntityNode } from './connectDoc';
import { applyClaimsBlock } from './claimDoc';
import { collectResearchRequests } from './researchInline';
import { dedupKeyFor } from './researchers';
import { flagEnrichmentGaps, isSparseEntity, enrichmentNeed, SPARSE_SOURCE_MAX } from './enrichTrigger';
import { computeEnrichmentGap, isFacetThin } from './enrichGap';

/** A person fully covered across most expected facets (role, education, employer, notable work, birth) —
 *  NOT facet-thin, so a multi-source instance is correctly left alone by the trigger. */
const RICH_PERSON_CLAIM = 'Richard Garfield is a game designer who created Magic: The Gathering; he earned a PhD from the University of Pennsylvania, joined Wizards of the Coast, and was born in 1963.';

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

describe('enrichmentNeed (RESEARCH-QUALITY) — qualitative gap, not just count', () => {
  it('count-sparse → needed (sparse reason takes precedence)', () => {
    const need = enrichmentNeed({ derivedFrom: ['s1'] }, { present: ['role or occupation'], missing: [] });
    expect(need.needed).toBe(true);
    expect(need.why).toMatch(/sparse entity/i);
  });
  it('multi-source but FACET-THIN → needed, with the missing facets named in the reason', () => {
    const gap = computeEnrichmentGap('person', []); // no claims → every facet missing
    expect(isFacetThin(gap)).toBe(true);
    const need = enrichmentNeed({ derivedFrom: ['s1', 's2', 's3'] }, gap);
    expect(need.needed).toBe(true);
    expect(need.why).toMatch(/thin coverage/i);
    expect(need.why).toContain('education'); // names the actual deficit (no jargon)
  });
  it('multi-source AND facet-rich → NOT needed', () => {
    const gap = computeEnrichmentGap('person', [RICH_PERSON_CLAIM]);
    expect(isFacetThin(gap)).toBe(false);
    expect(enrichmentNeed({ derivedFrom: ['s1', 's2'] }, gap).needed).toBe(false);
  });
});

describe('flagEnrichmentGaps (WS-B + RESEARCH-QUALITY) — the research-request producer', () => {
  it('emits for a sparse entity, none for a well-corroborated AND facet-rich one', async () => {
    await withRoot(async (root) => {
      await writeEntity(root, node({ id: 'E_SPARSE', name: 'Black Lotus', kind: 'artifact', derivedFrom: ['sources/ab/01'] }));
      // Multi-source AND facet-rich → not sparse, not facet-thin → left alone.
      const richRel = entityFileRel('person', 'Richard Garfield', 'E_RICH');
      const richAbs = path.join(root, richRel);
      await fs.mkdir(path.dirname(richAbs), { recursive: true });
      await fs.writeFile(richAbs, applyClaimsBlock(
        renderEntityNode(node({ id: 'E_RICH', name: 'Richard Garfield', kind: 'person', derivedFrom: ['sources/ab/01', 'sources/cd/02'] })),
        [{ claimPath: 'claims/x/01J.md', statement: RICH_PERSON_CLAIM, status: 'fact', confidence: 0.9 }],
      ), 'utf8');

      const emitted = await flagEnrichmentGaps(root, new Set(), { ts: TS });
      expect(emitted).toBe(1); // only the sparse entity

      // The emitted signal is readable back as a dispatchable ResearchRequest (the existing collect path).
      const reqs = await collectResearchRequests(root);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ what: 'Black Lotus', by: { stage: 'enrich', entityId: 'E_SPARSE' } });
      expect(reqs[0].dedupKey).toBe(dedupKeyFor({ what: 'Black Lotus', by: { entityId: 'E_SPARSE' } }));
      expect(reqs[0].why).toMatch(/sparse entity/i);
    });
  });

  it('RESEARCH-QUALITY: flags a multi-source but FACET-THIN entity (the count-only blind spot)', async () => {
    await withRoot(async (root) => {
      // Two sources (NOT count-sparse) but its only claim covers role — birth/education/etc. are the gap.
      const rel = entityFileRel('person', 'Margaret Hamilton', 'E_MH');
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const md = applyClaimsBlock(renderEntityNode(node({ id: 'E_MH', name: 'Margaret Hamilton', kind: 'person', derivedFrom: ['sources/ab/01', 'sources/cd/02'] })), [
        { claimPath: 'claims/x/01J.md', statement: 'Margaret Hamilton is a software engineer.', status: 'fact', confidence: 0.9 },
      ]);
      await fs.writeFile(abs, md, 'utf8');

      expect(await flagEnrichmentGaps(root, new Set(), { ts: TS })).toBe(1);
      const reqs = await collectResearchRequests(root);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].why).toMatch(/thin coverage/i); // flagged for the qualitative gap, not the count
      expect(reqs[0].gap?.missing).toContain('education');
    });
  });

  it('stamps the enrichment GAP from the entity claims, plumbed producer→collect (RESEARCH-24)', async () => {
    await withRoot(async (root) => {
      // A sparse person whose claims cover their role but not their education/birth → that's the gap.
      const rel = entityFileRel('person', 'Ada Lovelace', 'E_ADA');
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const md = applyClaimsBlock(renderEntityNode(node({ id: 'E_ADA', name: 'Ada Lovelace', kind: 'person', derivedFrom: ['sources/ab/01'] })), [
        { claimPath: 'claims/x/01J.md', statement: 'Ada is a mathematician and writer.', status: 'fact', confidence: 0.9 },
      ]);
      await fs.writeFile(abs, md, 'utf8');

      await flagEnrichmentGaps(root, new Set(), { ts: TS });
      const reqs = await collectResearchRequests(root);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].gap).toBeDefined();
      expect(reqs[0].gap?.present).toContain('role or occupation'); // covered by the present claim
      expect(reqs[0].gap?.missing).toContain('education'); // the gap an enrichment pass should target
      expect(reqs[0].gap?.missing).toContain('date of birth');
    });
  });

  it('is idempotent — skips an entity already carrying a pending request (no re-emit)', async () => {
    await withRoot(async (root) => {
      await writeEntity(root, node({ id: 'E1', name: 'Time Walk', kind: 'artifact', derivedFrom: ['sources/ab/01'] }));

      expect(await flagEnrichmentGaps(root, new Set(), { ts: TS })).toBe(1);
      // Second sweep passes the now-pending dedupKeys (what runInlineResearchSweep does) → no re-emit.
      const pending = new Set((await collectResearchRequests(root)).map((r) => r.dedupKey));
      expect(await flagEnrichmentGaps(root, pending, { ts: TS })).toBe(0);
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

      const emitted = await flagEnrichmentGaps(root, new Set(), { ts: TS });
      expect(emitted).toBe(1); // only the well-formed sparse entity
    });
  });

  it('is a no-op on a vault with no entities/ tree', async () => {
    await withRoot(async (root) => {
      await fs.mkdir(root, { recursive: true });
      expect(await flagEnrichmentGaps(root, new Set(), { ts: TS })).toBe(0);
    });
  });
});
