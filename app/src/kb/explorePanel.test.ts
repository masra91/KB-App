// SPEC-0039 EXPLORE — pure neighborhood-assembly (node tier). A fake read-only RecallTools surface
// feeds controlled entities/links/claims; we assert the 1-hop neighborhood, direction folding,
// bounded top-K + overflow, the center's claims, and the focus fallback + empty-graph behavior.
import { describe, it, expect, vi } from 'vitest';
import { buildNeighborhood, listExploreEntities, DEFAULT_TOP_K } from './explorePanel';
import type { RecallTools, EntityHit } from './recall';

function hit(over: Partial<EntityHit> & Pick<EntityHit, 'rel' | 'name'>): EntityHit {
  return { id: over.rel, kind: 'concept', aliases: [], confidence: 0.8, tags: [`type/${over.kind ?? 'concept'}`], derivedFrom: [], ...over };
}

/** A minimal fake of the read-only surface: entities by query substring, fixed links/claims per entity. */
function fakeTools(opts: {
  entities: EntityHit[];
  links?: Record<string, { outgoing?: string[]; incoming?: string[] }>; // keyed by rel; values are rels/names
  claims?: Record<string, { statement: string; status: string; confidence: number }[]>;
}): RecallTools {
  const links = opts.links ?? {};
  const claims = opts.claims ?? {};
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
    readNode: vi.fn(async () => null),
    readSource: vi.fn(async () => null),
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
    expect(nb.claims).toEqual([{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8 }]);
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
