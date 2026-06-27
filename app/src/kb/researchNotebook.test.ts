// Field notebook (SPEC-0028 RESEARCH-21, warm-start Slice 4a). Pure helpers + a real-FS round-trip +
// derive-from-audit. The notebook is a DERIVED, BOUNDED, self-healing digest of the researcher's OWN
// audit lineage — no egress, no sensitivity gate (ships unconditionally, D8).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendAuditEvent } from './audit';
import {
  areaKey,
  isAreaStale,
  boundNotebook,
  readNotebook,
  writeNotebook,
  deriveNotebook,
  knownSourceUrls,
  knownHosts,
  notebookPath,
  NOTEBOOK_STALE_MS,
  NOTEBOOK_HARVESTED_CAP,
  type FieldNotebook,
} from './researchNotebook';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-notebook-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
const nb = (over: Partial<FieldNotebook> = {}): FieldNotebook => ({ researcherId: 'web-1', areas: [], harvested: [], frontier: [], ...over });

describe('areaKey + isAreaStale', () => {
  it('areaKey normalizes the subject + appends the entity id when present', () => {
    expect(areaKey('Quantum Error Correction')).toBe('quantum error correction');
    expect(areaKey('Quantum Error Correction', 'entity-xyz')).toBe('quantum error correction::entity-xyz');
  });
  it('isAreaStale flips once the area is older than the staleness window (re-opens)', () => {
    const now = 1_000_000_000_000;
    expect(isAreaStale({ lastRunTs: now - 1000 }, now)).toBe(false);
    expect(isAreaStale({ lastRunTs: now - NOTEBOOK_STALE_MS - 1 }, now)).toBe(true);
  });
});

describe('readNotebook / writeNotebook round-trip (self-healing)', () => {
  it('writes then reads back the same notebook; missing/malformed → empty', async () => {
    await withTemp(async (root) => {
      expect(await readNotebook(root, 'web-1')).toEqual(nb()); // missing → empty
      const full = nb({ areas: [{ key: 'a', lastRunTs: 5, returned: 'finding', citations: 2 }], harvested: [{ host: 'arxiv.org', url: 'https://arxiv.org/abs/1', ts: 5 }] });
      await writeNotebook(root, 'web-1', full);
      expect(await readNotebook(root, 'web-1')).toEqual(full);
      // corrupt file → empty (never throws)
      await fs.writeFile(notebookPath(root, 'web-1'), 'not json');
      expect(await readNotebook(root, 'web-1')).toEqual(nb());
    });
  });
  it('refuses to write under an unsafe researcher id (#29)', async () => {
    await withTemp(async (root) => {
      await expect(writeNotebook(root, '../evil', nb({ researcherId: '../evil' }))).rejects.toThrow(/unsafe/);
    });
  });
});

describe('boundNotebook (rolling caps + stale prune)', () => {
  it('keeps the newest entries up to the caps and prunes harvested older than the window', () => {
    const now = 2_000_000_000_000;
    const harvested = Array.from({ length: NOTEBOOK_HARVESTED_CAP + 50 }, (_, i) => ({ host: `h${i}.com`, url: `https://h${i}.com/x`, ts: now - i }));
    harvested.push({ host: 'old.com', url: 'https://old.com/x', ts: now - NOTEBOOK_STALE_MS - 1 }); // stale → pruned
    const bounded = boundNotebook(nb({ harvested }), now);
    expect(bounded.harvested.length).toBe(NOTEBOOK_HARVESTED_CAP); // capped
    expect(bounded.harvested.some((s) => s.host === 'old.com')).toBe(false); // stale pruned
    expect(bounded.harvested[0].ts).toBe(now); // newest kept
  });
});

describe('knownSourceUrls / knownHosts (the result-level dedup set, RESEARCH-21)', () => {
  it('exposes the harvested URLs + hosts to steer toward net-new sources', () => {
    const n = nb({ harvested: [{ host: 'arxiv.org', url: 'https://arxiv.org/abs/1', ts: 1 }, { host: 'arxiv.org', url: 'https://arxiv.org/abs/2', ts: 2 }] });
    expect(knownSourceUrls(n)).toEqual(new Set(['https://arxiv.org/abs/1', 'https://arxiv.org/abs/2']));
    expect(knownHosts(n)).toEqual(new Set(['arxiv.org']));
  });
});

describe('deriveNotebook — rebuilt from the researcher OWN audit (RESEARCH-6, canonical)', () => {
  it('folds researched events into areas (newest outcome wins) + harvested sources', async () => {
    await withTemp(async (root) => {
      // Two passes on the same subject: an earlier no-finding, then a later finding with 2 citations.
      await appendAuditEvent(root, { actor: 'researcher', eventType: 'no-finding', ts: '2026-01-01T00:00:00.000Z', subjects: { researcherId: 'web-1' }, payload: { what: 'Project Atlas' } });
      await appendAuditEvent(root, { actor: 'researcher', eventType: 'researched', ts: '2026-02-01T00:00:00.000Z', subjects: { researcherId: 'web-1', sourceId: 'SRC1', entityId: 'ent-atlas' }, payload: { what: 'Project Atlas', citations: ['https://arxiv.org/abs/1', 'https://example.com/p'] } });
      // A different researcher's event must NOT bleed into web-1's notebook.
      await appendAuditEvent(root, { actor: 'researcher', eventType: 'researched', ts: '2026-02-02T00:00:00.000Z', subjects: { researcherId: 'web-2' }, payload: { what: 'Other', citations: ['https://other.com/x'] } });

      const now = Date.parse('2026-02-15T00:00:00.000Z');
      const derived = await deriveNotebook(root, 'web-1', now);

      // The subject with an entity keys with the entity; newest outcome (finding, 2 citations) wins.
      const area = derived.areas.find((a) => a.key === areaKey('Project Atlas', 'ent-atlas'));
      expect(area).toMatchObject({ returned: 'finding', citations: 2 });
      // Harvested carries the cited URLs (host extracted), and NOT the other researcher's source.
      expect(knownSourceUrls(derived)).toEqual(new Set(['https://arxiv.org/abs/1', 'https://example.com/p']));
      expect(derived.harvested.find((s) => s.url === 'https://arxiv.org/abs/1')?.host).toBe('arxiv.org');
      // No event carried a gap/angle → nothing to seed the frontier (it's audit-derived now, not carried).
      expect(derived.frontier).toEqual([]);
    });
  });

  it('RESEARCH-QUALITY: derives the frontier from gap leads + marks drilled facets, so re-runs rotate', async () => {
    await withTemp(async (root) => {
      const gap = { present: ['role or occupation'], missing: ['education', 'date of birth', 'notable work or achievement'] };
      // One pass drilled the `education` facet (angle records it) against a 3-missing-facet gap.
      await appendAuditEvent(root, {
        actor: 'researcher', eventType: 'researched', ts: '2026-02-01T00:00:00.000Z',
        subjects: { researcherId: 'web-1', sourceId: 'SRC1', entityId: 'ent-ada' },
        payload: { what: 'Ada Lovelace', citations: ['https://x.com/a'], angle: 're Ada Lovelace: education', gap },
      });
      const now = Date.parse('2026-02-10T00:00:00.000Z');
      const derived = await deriveNotebook(root, 'web-1', now);

      const key = areaKey('Ada Lovelace', 'ent-ada');
      // The drilled angle is recorded on the area → orient's exclusion set.
      expect(derived.areas.find((a) => a.key === key)?.targetedFacets).toEqual(['re Ada Lovelace: education']);
      // The frontier holds the STILL-uncovered facets (not the one already drilled) — the rotation pool.
      const terms = derived.frontier.map((f) => f.term).sort();
      expect(terms).toEqual(['date of birth', 'notable work or achievement']);
      expect(derived.frontier.every((f) => f.fromSourceId === 'SRC1')).toBe(true);
    });
  });

  it('RESEARCH-QUALITY: a stale drilled facet re-opens (drops out of the exclusion set)', async () => {
    await withTemp(async (root) => {
      const gap: { present: string[]; missing: string[] } = { present: [], missing: ['founding date'] };
      await appendAuditEvent(root, {
        actor: 'researcher', eventType: 'researched', ts: '2026-01-01T00:00:00.000Z',
        subjects: { researcherId: 'web-1', sourceId: 'SRC1', entityId: 'ent-acme' },
        payload: { what: 'Acme Corp', citations: [], angle: 're Acme Corp: founding date', gap },
      });
      // Well past the staleness window → the old drilled facet no longer suppresses, and re-surfaces as a lead.
      const now = Date.parse('2026-01-01T00:00:00.000Z') + NOTEBOOK_STALE_MS + 1;
      const derived = await deriveNotebook(root, 'web-1', now);
      expect(derived.areas.find((a) => a.key === areaKey('Acme Corp', 'ent-acme'))?.targetedFacets ?? []).toEqual([]);
      expect(derived.frontier.map((f) => f.term)).toEqual(['founding date']);
    });
  });
});
