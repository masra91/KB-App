// SPEC-0039 EXPLORE — pure neighborhood-assembly (node tier). A fake read-only RecallTools surface
// feeds controlled entities/links/claims; we assert the 1-hop neighborhood, direction folding,
// bounded top-K + overflow, the center's claims, and the focus fallback + empty-graph behavior.
import { describe, it, expect, vi } from 'vitest';
import { buildNeighborhood, listExploreEntities, DEFAULT_TOP_K, EDGE_ASSERTED_AT } from './explorePanel';
import type { RecallTools, EntityHit } from './recall';
import { blockKey } from './connect';
import { contradictionClaimKey, type ContradictionDirective, type ContradictionState } from './directives';

function hit(over: Partial<EntityHit> & Pick<EntityHit, 'rel' | 'name'>): EntityHit {
  return { id: over.rel, kind: 'concept', aliases: [], confidence: 0.8, tags: [`type/${over.kind ?? 'concept'}`], derivedFrom: [], ...over };
}

interface FakeClaim {
  statement: string;
  status: string;
  confidence: number;
  derivedFrom?: string[]; // source dir(s) the claim cites (WS-A)
}

/** A minimal fake of the read-only surface: entities by query substring, fixed links/claims per entity. */
function fakeTools(opts: {
  entities: EntityHit[];
  links?: Record<string, { outgoing?: string[]; incoming?: string[] }>; // keyed by rel; values are rels/names
  claims?: Record<string, FakeClaim[]>;
  sources?: Record<string, string>; // source dir → its source.md content (for title derivation, WS-A)
  nodes?: Record<string, string>; // entity rel → its node markdown (the links block, for predicate parse)
}): RecallTools {
  const links = opts.links ?? {};
  const claims = opts.claims ?? {};
  const sources = opts.sources ?? {};
  const nodes = opts.nodes ?? {};
  return {
    entityLookup: vi.fn(async ({ query }: { query: string }) => {
      const n = (query ?? '').toLowerCase();
      return opts.entities.filter((e) => n === '' || e.name.toLowerCase().includes(n));
    }),
    claimsForEntity: vi.fn(async ({ entity }: { entity: string }) =>
      (claims[entity] ?? []).map((c) => ({ rel: `claims/x.md`, id: 'c', subject: entity, derivedFrom: [] as string[], mentions: [] as string[], relatesTo: [] as string[], ...c })),
    ),
    linkTraversal: vi.fn(async ({ entity }: { entity: string }) => {
      const l = links[entity] ?? {};
      return {
        outgoing: (l.outgoing ?? []).map((to) => ({ from: entity, to })),
        incoming: (l.incoming ?? []).map((from) => ({ from, to: entity })),
      };
    }),
    readNode: vi.fn(async ({ rel }: { rel: string }) => nodes[rel] ?? null),
    readSource: vi.fn(async ({ dir }: { dir: string }) => sources[dir] ?? null),
    grep: vi.fn(async () => []),
  };
}

const ATLAS = hit({ rel: 'entities/project/atlas.md', name: 'Project Atlas', kind: 'project', confidence: 0.9 });
const FINANCE = hit({ rel: 'entities/org/finance.md', name: 'Finance Team', kind: 'organization', confidence: 0.7 });
const STEVE = hit({ rel: 'entities/person/steve.md', name: 'Steve Park', kind: 'person', confidence: 0.6 });

describe('explorePanel — listExploreEntities', () => {
  it('returns all entities as lightweight refs, sorted by name', async () => {
    const tools = fakeTools({ entities: [ATLAS, FINANCE, STEVE] });
    const list = await listExploreEntities(tools);
    expect(list.map((e) => e.name)).toEqual(['Finance Team', 'Project Atlas', 'Steve Park']);
    expect(list[1]).toMatchObject({ rel: 'entities/project/atlas.md', kind: 'project', confidence: 0.9 });
  });
});

describe('explorePanel — buildNeighborhood', () => {
  it('centers the focused entity and returns its 1-hop neighbors with direction', async () => {
    const tools = fakeTools({
      entities: [ATLAS, FINANCE, STEVE],
      links: {
        'entities/project/atlas.md': { outgoing: ['entities/org/finance.md|Finance Team'], incoming: ['entities/person/steve.md'] },
      },
      claims: { 'entities/project/atlas.md': [{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8 }] },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.found).toBe(true);
    expect(nb.center?.name).toBe('Project Atlas');
    expect(nb.center?.rel).toBe('entities/project/atlas.md');
    // Finance is an outgoing wikilink (parsed past the |alias); Steve is an incoming backlink.
    const byName = Object.fromEntries(nb.neighbors.map((x) => [x.name, x.direction]));
    expect(byName).toEqual({ 'Finance Team': 'out', 'Steve Park': 'in' });
    // the center's claims ride along (the read-only "leads back to reading" affordance)
    expect(nb.claims).toEqual([{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8, citations: [], contested: false }]);
  });

  // SPEC-0036 CONTRA-6/7 — the contradiction flag surfaces in the read view, keyed on the center's STABLE
  // block identity. A small helper builds the durable-store map the IPC handler would pre-read.
  const contraMap = (state: ContradictionState): Map<string, ContradictionDirective> => {
    const identity = blockKey('project', 'Project Atlas');
    const key = contradictionClaimKey(identity, 'Funded for Q3', 'Cut from the Q3 budget.');
    return new Map([
      [key, { contradictionKey: key, identityKey: identity, statements: ['Cut from the Q3 budget.', 'Funded for Q3'], state, reviewId: 'r', decidedAt: '1' }],
    ]);
  };
  const atlasWithClaims = (): RecallTools =>
    fakeTools({
      entities: [ATLAS, FINANCE],
      claims: {
        'entities/project/atlas.md': [
          { statement: 'Funded for Q3', status: 'fact', confidence: 0.8 },
          { statement: 'Led by Ada', status: 'fact', confidence: 0.7 },
        ],
      },
    });

  it('CONTRA: an OPEN contradiction flags the center + marks the participating claim disputed (not its siblings)', async () => {
    const nb = await buildNeighborhood(atlasWithClaims(), 'Project Atlas', undefined, contraMap('needs-you'));
    // The center carries the open-contradiction flag with both conflicting statements (never one asserted).
    expect(nb.contradictions).toHaveLength(1);
    expect(nb.contradictions[0].statements).toEqual(['Cut from the Q3 budget.', 'Funded for Q3']);
    // The claim in the contradiction is contested; the unrelated claim is not.
    expect(nb.claims.find((c) => c.statement === 'Funded for Q3')?.contested).toBe(true);
    expect(nb.claims.find((c) => c.statement === 'Led by Ada')?.contested).toBe(false);
  });

  it('CONTRA: a RESOLVED contradiction clears the flag (no contest); ACCEPTED stays contested (CONTRA-6)', async () => {
    const resolved = await buildNeighborhood(atlasWithClaims(), 'Project Atlas', undefined, contraMap('resolved'));
    expect(resolved.contradictions).toHaveLength(0); // flag cleared
    expect(resolved.claims.find((c) => c.statement === 'Funded for Q3')?.contested).toBe(false);

    const accepted = await buildNeighborhood(atlasWithClaims(), 'Project Atlas', undefined, contraMap('accepted'));
    expect(accepted.contradictions).toHaveLength(0); // accepted leaves the needs-you flag, but…
    expect(accepted.claims.find((c) => c.statement === 'Funded for Q3')?.contested).toBe(true); // …still contested at recall
  });

  it('CONTRA: no contradictions map (default) → nothing contested, fully backward-compatible', async () => {
    const nb = await buildNeighborhood(atlasWithClaims(), 'Project Atlas');
    expect(nb.contradictions).toEqual([]);
    expect(nb.claims.every((c) => c.contested === false)).toBe(true);
  });

  it('folds a mutual link to direction "both" and never lists the focus as its own neighbor', async () => {
    const tools = fakeTools({
      entities: [ATLAS, FINANCE],
      links: {
        'entities/project/atlas.md': { outgoing: ['entities/org/finance.md', 'entities/project/atlas.md'], incoming: ['entities/org/finance.md'] },
      },
    });
    const nb = await buildNeighborhood(tools, 'entities/project/atlas.md');
    expect(nb.neighbors).toHaveLength(1);
    expect(nb.neighbors[0]).toMatchObject({ name: 'Finance Team', direction: 'both' });
  });

  it('excludes incoming backlinks that are not entities (e.g. claim files — not graph nodes)', async () => {
    const tools = fakeTools({
      entities: [ATLAS, FINANCE],
      links: { 'entities/project/atlas.md': { incoming: ['claims/01H.md', 'entities/org/finance.md'] } },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.neighbors.map((n) => n.name)).toEqual(['Finance Team']); // the claim backlink is dropped
  });

  it('ranks neighbors by confidence and bounds to top-K with a total for the "+N more" overflow', async () => {
    const many = Array.from({ length: DEFAULT_TOP_K + 5 }, (_, i) =>
      hit({ rel: `entities/concept/n${i}.md`, name: `N${String(i).padStart(2, '0')}`, confidence: i / 100 }),
    );
    const tools = fakeTools({
      entities: [ATLAS, ...many],
      links: { 'entities/project/atlas.md': { outgoing: many.map((m) => m.rel) } },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.total).toBe(DEFAULT_TOP_K + 5);
    expect(nb.shown).toBe(DEFAULT_TOP_K);
    expect(nb.neighbors).toHaveLength(DEFAULT_TOP_K);
    // highest-confidence first
    expect(nb.neighbors[0].confidence).toBeGreaterThanOrEqual(nb.neighbors[1].confidence);
  });

  it('a focus with no promoted links resolves but returns an empty neighborhood (the sparse state, EXPLORE-11)', async () => {
    const tools = fakeTools({ entities: [ATLAS, FINANCE] });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.found).toBe(true);
    expect(nb.center?.name).toBe('Project Atlas');
    expect(nb.neighbors).toHaveLength(0);
    expect(nb.total).toBe(0);
  });

  it('falls back to the highest-confidence entity when the focus is missing/unresolved', async () => {
    const tools = fakeTools({ entities: [FINANCE, ATLAS, STEVE] });
    const nb = await buildNeighborhood(tools, 'does-not-exist');
    expect(nb.center?.name).toBe('Project Atlas'); // 0.9 is highest
  });

  it('reports found:false when the graph has no entities at all', async () => {
    const nb = await buildNeighborhood(fakeTools({ entities: [] }));
    expect(nb.found).toBe(false);
    expect(nb.neighbors).toHaveLength(0);
  });
});

describe('explorePanel — typed, confidence-bearing edges (EXPLORE-5)', () => {
  // A center node's generated links block (CONNECT-12): `- <predicate> [[targetRel|Name]]`, plus a
  // bare (predicate-less) link and a claims-block row that must NOT leak a predicate to any entity.
  const ATLAS_NODE = [
    '# Project Atlas',
    '<!-- kb:links:start (generated — edit via Connect, not here) -->',
    '- funds [[entities/org/finance.md|Finance Team]]',
    '- [[entities/person/steve.md|Steve Park]]',
    '<!-- kb:links:end -->',
    '<!-- kb:claims:start -->',
    '- [[claims/01H.md]] — Funded for Q3 *(fact, 0.8)*',
    '<!-- kb:claims:end -->',
  ].join('\n');

  it('surfaces an outgoing edge’s relationship predicate from the center’s links block', async () => {
    const tools = fakeTools({
      entities: [ATLAS, FINANCE, STEVE],
      nodes: { 'entities/project/atlas.md': ATLAS_NODE },
      links: {
        'entities/project/atlas.md': { outgoing: ['entities/org/finance.md|Finance Team', 'entities/person/steve.md|Steve Park'] },
      },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    const byName = Object.fromEntries(nb.neighbors.map((n) => [n.name, n.predicate]));
    expect(byName['Finance Team']).toBe('funds'); // typed edge
    expect(byName['Steve Park']).toBeUndefined(); // bare link → no predicate (the usual v1 case)
  });

  it('does not assign a predicate to incoming-only edges in v1 (documented bound)', async () => {
    const tools = fakeTools({
      entities: [ATLAS, FINANCE],
      nodes: { 'entities/project/atlas.md': ATLAS_NODE },
      links: { 'entities/project/atlas.md': { incoming: ['entities/org/finance.md'] } },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.neighbors[0]).toMatchObject({ name: 'Finance Team', direction: 'in', predicate: undefined });
  });

  it('flags low-confidence edges speculative and asserted edges not (the EDGE_ASSERTED_AT cut)', async () => {
    const high = hit({ rel: 'entities/x/high.md', name: 'High', confidence: EDGE_ASSERTED_AT }); // == cut → asserted
    const low = hit({ rel: 'entities/x/low.md', name: 'Low', confidence: EDGE_ASSERTED_AT - 0.1 }); // below → speculative
    const tools = fakeTools({
      entities: [ATLAS, high, low],
      links: { 'entities/project/atlas.md': { outgoing: ['entities/x/high.md', 'entities/x/low.md'] } },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    const spec = Object.fromEntries(nb.neighbors.map((n) => [n.name, n.speculative]));
    expect(spec).toEqual({ High: false, Low: true });
  });

  it('tolerates an unreadable center node — edges still render, just without predicates (ENG-16)', async () => {
    const tools = fakeTools({
      entities: [ATLAS, FINANCE],
      // no `nodes` entry → readNode returns null
      links: { 'entities/project/atlas.md': { outgoing: ['entities/org/finance.md|Finance Team'] } },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.neighbors).toHaveLength(1);
    expect(nb.neighbors[0]).toMatchObject({ name: 'Finance Team', predicate: undefined });
  });
});

describe('explorePanel — clickable cited sources (SPEC-0046 WS-A)', () => {
  it('attaches each claim its cited sources as a titled, openable ref (never a ULID)', async () => {
    const tools = fakeTools({
      entities: [ATLAS],
      claims: {
        'entities/project/atlas.md': [{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8, derivedFrom: ['sources/ab/01JABC'] }],
      },
      sources: { 'sources/ab/01JABC': '---\ntitle: Q3 board memo\n---\nbody' },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.claims[0].citations).toEqual([{ ref: 'sources/ab/01JABC/source.md', title: 'Q3 board memo' }]);
    // the ref is the `source.md` path (what openSourceRef resolves), the title is human — not the ULID dir
    expect(nb.claims[0].citations[0].title).not.toContain('01JABC');
  });

  it('dedupes repeated source dirs and reads each distinct source title only once', async () => {
    const tools = fakeTools({
      entities: [ATLAS],
      claims: {
        'entities/project/atlas.md': [
          { statement: 'A', status: 'fact', confidence: 0.8, derivedFrom: ['sources/ab/01JABC', 'sources/ab/01JABC'] },
          { statement: 'B', status: 'fact', confidence: 0.7, derivedFrom: ['sources/ab/01JABC'] },
        ],
      },
      sources: { 'sources/ab/01JABC': '---\ntitle: Q3 board memo\n---\nbody' },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.claims[0].citations).toHaveLength(1); // de-duped within the claim
    expect(nb.claims[1].citations[0].title).toBe('Q3 board memo');
    expect(tools.readSource).toHaveBeenCalledTimes(1); // distinct source read once across claims
  });

  it('tolerates an unreadable / dangling source — surfaces a neutral title, never crashes (ENG-16)', async () => {
    const tools = fakeTools({
      entities: [ATLAS],
      claims: {
        'entities/project/atlas.md': [{ statement: 'X', status: 'fact', confidence: 0.8, derivedFrom: ['sources/zz/missing'] }],
      },
      // no `sources` entry → readSource returns null
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.claims[0].citations).toHaveLength(1);
    expect(nb.claims[0].citations[0].ref).toBe('sources/zz/missing/source.md');
    expect(nb.claims[0].citations[0].title.length).toBeGreaterThan(0); // a generic, never empty / a ULID
  });

  it('a claim with no cited sources carries an empty citations list (partial-data, ENG-15)', async () => {
    const tools = fakeTools({
      entities: [ATLAS],
      claims: { 'entities/project/atlas.md': [{ statement: 'uncited', status: 'hypothesis', confidence: 0.4 }] },
    });
    const nb = await buildNeighborhood(tools, 'Project Atlas');
    expect(nb.claims[0].citations).toEqual([]);
  });
});
