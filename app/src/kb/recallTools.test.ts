// SPEC-0026 ASK-4/5 — the read-only recall tool surface over a real on-disk graph.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir } from '../../test/tempVault';
import { makeReadOnlyTools, parseClaimMd } from './recallTools';
import { renderClaimMd } from './claimDoc';
import type { RecallTools } from './recall';

describe('parseClaimMd — statement excludes the VAULT-13 source trailer (regression: #99×#102)', () => {
  it('reads the statement as the first body line, not the whole body with its Source: [[…]] citation', () => {
    const md = renderClaimMd(
      { statement: 'Ada Lovelace worked with Charles Babbage.', status: 'fact', confidence: 0.9, mentions: ['m'] },
      { id: '01C', subject: 'entities/person/ada.md', derivedFrom: 'sources/2026/06/02/01SRC', createdAt: '2026-06-02T00:00:00Z' },
    );
    expect(md).toContain('Source: [['); // the file DOES carry the clickable citation (VAULT-13)
    const parsed = parseClaimMd(md);
    expect(parsed.statement).toBe('Ada Lovelace worked with Charles Babbage.'); // …but the statement is clean
    expect(parsed.statement).not.toContain('Source:');
  });
});

describe('recall read-only tools (ASK-4/5)', () => {
  let v: RecallVault;
  let tools: RecallTools;
  beforeAll(async () => {
    v = await buildRecallVault();
    tools = makeReadOnlyTools(v.root);
  });
  afterAll(async () => {
    await rmTempDir(v.root);
  });

  it('entityLookup finds by name, alias, and filters by kind; surfaces tags (META)', async () => {
    const ada = await tools.entityLookup({ query: 'ada' });
    expect(ada.map((e) => e.rel)).toContain(v.adaRel);
    expect(ada.find((e) => e.rel === v.adaRel)?.tags).toContain('type/person');
    expect((await tools.entityLookup({ query: 'Lovelace' })).some((e) => e.name === 'Ada Lovelace')).toBe(true);
    expect((await tools.entityLookup({ query: '', kind: 'concept' })).map((e) => e.rel)).toEqual([v.engineRel]);
  });

  it('claimsForEntity matches by entity name or rel-path; unknown → none', async () => {
    const byName = await tools.claimsForEntity({ entity: 'Ada Lovelace' });
    expect(byName).toHaveLength(1);
    expect(byName[0].rel).toBe(v.claimRel);
    expect(byName[0].status).toBe('fact');
    expect(byName[0].subject).toBe(v.adaRel);
    expect(byName[0].mentions).toContain('first computer programmer');
    expect(await tools.claimsForEntity({ entity: v.adaRel })).toHaveLength(1);
    expect(await tools.claimsForEntity({ entity: 'Nobody' })).toEqual([]);
  });

  it('linkTraversal returns outgoing wikilinks and incoming backlinks', async () => {
    const { outgoing, incoming } = await tools.linkTraversal({ entity: 'Ada Lovelace' });
    expect(outgoing.map((l) => l.to)).toContain(v.engineRel);
    expect(incoming.some((l) => l.from === v.engineRel && l.to === v.adaRel)).toBe(true);
  });

  it('readNode reads entity/claim docs; refuses sources, missing, and out-of-bounds paths', async () => {
    expect(await tools.readNode({ rel: v.adaRel })).toContain('Ada Lovelace');
    expect(await tools.readNode({ rel: v.claimRel })).toContain('first computer programmer');
    expect(await tools.readNode({ rel: `${v.sourceDir}/source.md` })).toBeNull(); // sources only via readSource
    expect(await tools.readNode({ rel: '../../../etc/passwd' })).toBeNull(); // escape blocked
    expect(await tools.readNode({ rel: 'entities/person/missing.md' })).toBeNull();
  });

  it('readSource reads source.md ground truth (dir or explicit file); non-source → null', async () => {
    expect(await tools.readSource({ dir: v.sourceDir })).toContain('Analytical Engine');
    expect(await tools.readSource({ dir: `${v.sourceDir}/source.md` })).toContain('Analytical Engine');
    expect(await tools.readSource({ dir: 'sources/nope' })).toBeNull();
    expect(await tools.readSource({ dir: v.adaRel })).toBeNull(); // not under sources/
  });

  it('grep does a bounded, case-insensitive line search; empty pattern → nothing', async () => {
    const hits = await tools.grep({ pattern: 'analytical' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.toLowerCase().includes('analytical'))).toBe(true);
    expect(await tools.grep({ pattern: '' })).toEqual([]);
  });
});
