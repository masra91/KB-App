// @vitest-environment happy-dom
//
// SPEC-0039 EXPLORE — the Explore view, component tier (happy-dom; IPC mocked). Asserts the rendered
// entity-neighborhood (center + 1-hop neighbors with edge direction), search-to-focus, click-to-
// re-center + breadcrumb, the sparse/empty states (EXPLORE-11), the "+N more" overflow, open-in-
// Obsidian (EXPLORE-4 click-through), and the §10 instrument-language composition (no native <select>).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountExplore } from './exploreView';
import type { KbApi } from '../../kb/types';
import type { ExploreEntityRef, ExploreNeighborhood } from '../../kb/explorePanel';

const ENTITIES: ExploreEntityRef[] = [
  { rel: 'entities/project/atlas.md', id: 'a', name: 'Project Atlas', kind: 'project', confidence: 0.9 },
  { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7 },
];

function neighborhood(over: Partial<ExploreNeighborhood> = {}): ExploreNeighborhood {
  return {
    found: true,
    center: { rel: 'entities/project/atlas.md', id: 'a', name: 'Project Atlas', kind: 'project', confidence: 0.9, tags: ['type/project', 'topic/q3'] },
    claims: [{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8, citations: [] }],
    neighbors: [
      { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out', predicate: 'funds', speculative: false },
      { rel: 'entities/person/steve.md', id: 's', name: 'Steve Park', kind: 'person', confidence: 0.6, direction: 'in', speculative: true },
    ],
    shown: 2,
    total: 2,
    ...over,
  };
}

let exploreNeighborhood: ReturnType<typeof vi.fn>;
let exploreEntities: ReturnType<typeof vi.fn>;
let openCitation: ReturnType<typeof vi.fn>;
let openSourceRef: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    exploreNeighborhood: exploreNeighborhood as unknown as KbApi['exploreNeighborhood'],
    exploreEntities: exploreEntities as unknown as KbApi['exploreEntities'],
    openCitation: openCitation as unknown as KbApi['openCitation'],
    openSourceRef: openSourceRef as unknown as KbApi['openSourceRef'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  exploreNeighborhood = vi.fn(async () => neighborhood());
  exploreEntities = vi.fn(async () => ENTITIES);
  openCitation = vi.fn(async () => ({ ok: true as const }));
  openSourceRef = vi.fn(async () => ({ status: 'opened' as const }));
  setApi();
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  await mountExplore(c);
  await flush();
  return c;
}

describe('Explore view — neighborhood render (EXPLORE-2/4)', () => {
  it('renders the focused entity (name + kind chip + tags) and its claims inline', async () => {
    const c = await mount();
    expect(c.querySelector('.explore-center-name')?.textContent).toBe('Project Atlas');
    expect(c.querySelector('.explore-center .explore-kind')?.textContent).toBe('project');
    expect(c.querySelectorAll('.explore-tag').length).toBe(2);
    expect(c.querySelector('.explore-claim')?.textContent).toContain('Funded for Q3');
  });

  it('renders the 1-hop neighbors with their edge direction glyph', async () => {
    const c = await mount();
    const names = Array.from(c.querySelectorAll('.explore-neighbor-name')).map((n) => n.textContent);
    expect(names).toEqual(['Finance Team', 'Steve Park']);
    const edges = Array.from(c.querySelectorAll('.explore-edge')).map((e) => e.textContent);
    expect(edges).toEqual(['→', '←']); // out, in
  });

  it('renders an edge’s relationship predicate as a label, and shows none when absent (EXPLORE-5)', async () => {
    const c = await mount();
    const rels = Array.from(c.querySelectorAll('.explore-rel')).map((e) => e.textContent);
    expect(rels).toEqual(['funds']); // Finance has the predicate; Steve (no predicate) shows no label
  });

  it('marks a low-confidence edge speculative (faded class + ~conf), an asserted one not (EXPLORE-5/DATA-8)', async () => {
    const c = await mount();
    const items = Array.from(c.querySelectorAll('.explore-neighbor'));
    const finance = items.find((li) => li.textContent?.includes('Finance Team'))!;
    const steve = items.find((li) => li.textContent?.includes('Steve Park'))!;
    expect(finance.classList.contains('explore-neighbor--speculative')).toBe(false);
    expect(steve.classList.contains('explore-neighbor--speculative')).toBe(true);
    // the non-color a11y signal: speculative confidence is `~`-prefixed
    expect(steve.querySelector('.explore-conf')?.textContent).toBe('~0.60');
    expect(finance.querySelector('.explore-conf')?.textContent).toBe('0.70');
  });

  it('partial data: a neighbor missing kind/predicate renders without breaking siblings (ENG-15/16)', async () => {
    exploreNeighborhood = vi.fn(async () =>
      neighborhood({
        neighbors: [
          // a legacy/partial neighbor: empty kind, no predicate, odd confidence — must not crash the row
          { rel: 'entities/x/partial.md', id: 'p', name: 'Partial Node', kind: '', confidence: 0.5, direction: 'both', speculative: true },
          { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out', predicate: 'funds', speculative: false },
        ],
        shown: 2,
        total: 2,
      }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.explore-neighbor')).toHaveLength(2); // both render
    const names = Array.from(c.querySelectorAll('.explore-neighbor-name')).map((n) => n.textContent);
    expect(names).toEqual(['Partial Node', 'Finance Team']);
  });

  it('composes the instrument language — no native <select> anywhere (EXPLORE-10)', async () => {
    const c = await mount();
    expect(c.querySelectorAll('select')).toHaveLength(0);
    expect(c.querySelector('.explore.viz-surface')).not.toBeNull();
    expect(c.querySelector('.explore-center.viz-no-chrome')).not.toBeNull();
  });
});

describe('Explore view — navigate (EXPLORE-6)', () => {
  it('clicking a neighbor re-centers on it and pushes a breadcrumb', async () => {
    const c = await mount();
    exploreNeighborhood.mockClear();
    c.querySelector<HTMLButtonElement>('.explore-recenter[data-rel="entities/org/finance.md"]')!.click();
    await flush();
    expect(exploreNeighborhood).toHaveBeenCalledWith('entities/org/finance.md');
    // the prior focus (Project Atlas) is now a clickable breadcrumb
    const crumb = c.querySelector('.explore-crumb[data-rel="entities/project/atlas.md"]');
    expect(crumb?.textContent).toBe('Project Atlas');
  });

  it('typing a name + Enter focuses that entity and resets the trail', async () => {
    const c = await mount();
    // walk once so there's a trail
    c.querySelector<HTMLButtonElement>('.explore-recenter[data-rel="entities/org/finance.md"]')!.click();
    await flush();
    exploreNeighborhood.mockClear();
    const input = c.querySelector<HTMLInputElement>('.explore-focus')!;
    input.value = 'Finance Team';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(exploreNeighborhood).toHaveBeenCalledWith('Finance Team');
    expect(c.querySelectorAll('.explore-crumb[data-rel]')).toHaveLength(0); // trail reset on a fresh search
  });

  it('the search uses a datalist of all entities (autocomplete, not a generic dropdown)', async () => {
    const c = await mount();
    const opts = Array.from(c.querySelectorAll('#exploreEntities option')).map((o) => o.getAttribute('value'));
    expect(opts).toEqual(['Project Atlas', 'Finance Team']);
  });
});

describe('Explore view — click-through (EXPLORE-4)', () => {
  it('"Open in Obsidian" opens the focused entity via openCitation', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-open')!.click();
    expect(openCitation).toHaveBeenCalledWith('entities/project/atlas.md');
  });
});

describe('Explore view — clickable wiki-citations (SPEC-0046 WS-A)', () => {
  const cited = (): ExploreNeighborhood =>
    neighborhood({
      claims: [{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8, citations: [{ ref: 'sources/ab/01JABC/source.md', title: 'Q3 board memo' }] }],
    });

  it('renders a claim\'s cited source as a clickable, titled affordance (not a ULID)', async () => {
    exploreNeighborhood = vi.fn(async () => cited());
    setApi();
    const c = await mount();
    const cite = c.querySelector<HTMLButtonElement>('.explore-cite');
    expect(cite).not.toBeNull();
    expect(cite!.textContent).toContain('Q3 board memo');
    expect(cite!.textContent).not.toContain('01JABC'); // human title, never the id
    expect(cite!.dataset.ref).toBe('sources/ab/01JABC/source.md');
  });

  it('clicking a citation opens the source working-zone-aware via openSourceRef', async () => {
    exploreNeighborhood = vi.fn(async () => cited());
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-cite')!.click();
    await flush();
    expect(openSourceRef).toHaveBeenCalledWith('sources/ab/01JABC/source.md');
    expect(c.querySelector('.explore-cite-note')?.textContent).toBe(''); // a clean open shows no error
  });

  it('a staging-only source surfaces a calm inline note, never a dead link (REVIEW-17)', async () => {
    openSourceRef = vi.fn(async () => ({ status: 'staging' as const }));
    exploreNeighborhood = vi.fn(async () => cited());
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-cite')!.click();
    await flush();
    expect(c.querySelector('.explore-cite-note')?.textContent).toMatch(/still processing/i);
  });

  it('a missing source surfaces a graceful note (not a crash)', async () => {
    openSourceRef = vi.fn(async () => ({ status: 'missing' as const }));
    exploreNeighborhood = vi.fn(async () => cited());
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-cite')!.click();
    await flush();
    expect(c.querySelector('.explore-cite-note')?.textContent).toMatch(/isn’t in your vault/i);
  });

  it('a rejected openSourceRef IPC degrades to an inline note, never throws (ENG-16)', async () => {
    openSourceRef = vi.fn(async () => {
      throw new Error('ipc down');
    });
    exploreNeighborhood = vi.fn(async () => cited());
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-cite')!.click();
    await flush();
    expect(c.querySelector('.explore-cite-note')?.textContent).toContain('ipc down');
  });

  it('partial data: a claim with no citations + one with a malformed citation render without breaking siblings (ENG-15/16)', async () => {
    exploreNeighborhood = vi.fn(async () =>
      neighborhood({
        claims: [
          { statement: 'No sources here', status: 'hypothesis', confidence: 0.4, citations: [] },
          { statement: 'Bad ref', status: 'fact', confidence: 0.5, citations: [{ ref: '', title: 'broken' }] },
          { statement: 'Good one', status: 'fact', confidence: 0.8, citations: [{ ref: 'sources/cd/02JXYZ/source.md', title: 'Memo' }] },
        ],
      }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.explore-claim')).toHaveLength(3); // all three claims render
    const refs = Array.from(c.querySelectorAll<HTMLButtonElement>('.explore-cite')).map((b) => b.dataset.ref);
    expect(refs).toEqual(['sources/cd/02JXYZ/source.md']); // only the valid citation becomes a button
  });

  it('a [[Name]] woven into a claim is clickable and re-centers on that entity', async () => {
    exploreNeighborhood = vi.fn(async () =>
      neighborhood({ claims: [{ statement: 'Works with [[Finance Team]] closely', status: 'fact', confidence: 0.8, citations: [] }] }),
    );
    setApi();
    const c = await mount();
    const link = c.querySelector<HTMLButtonElement>('.explore-statement-link');
    expect(link?.textContent).toBe('Finance Team');
    exploreNeighborhood.mockClear();
    link!.click();
    await flush();
    expect(exploreNeighborhood).toHaveBeenCalledWith('Finance Team');
  });
});

describe('Explore view — empty + sparse states (EXPLORE-11)', () => {
  it('an empty graph (no entities) renders a clean explanatory state, not a broken canvas', async () => {
    exploreNeighborhood = vi.fn(async () => neighborhood({ found: false, center: undefined, claims: [], neighbors: [], shown: 0, total: 0 }));
    exploreEntities = vi.fn(async () => []);
    setApi();
    const c = await mount();
    expect(c.querySelector('.explore-empty')).not.toBeNull();
    expect(c.querySelector('.explore-center')).toBeNull();
  });

  it('a focused entity with no promoted links renders the sparse state with a why', async () => {
    exploreNeighborhood = vi.fn(async () => neighborhood({ neighbors: [], shown: 0, total: 0 }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.explore-center-name')?.textContent).toBe('Project Atlas'); // center still shown
    expect(c.querySelector('.explore-neighbors-empty')?.textContent).toMatch(/no relationships promoted yet/i);
  });
});

describe('Explore view — bounded neighborhood (EXPLORE-8)', () => {
  it('shows a "+N more" overflow note when the hub exceeds the shown count', async () => {
    exploreNeighborhood = vi.fn(async () =>
      neighborhood({ neighbors: [{ rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out', speculative: false }], shown: 1, total: 9 }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelector('.explore-more')?.textContent).toContain('+8 more');
    expect(c.querySelector('.explore-neighbors-head')?.textContent).toContain('1/9');
  });
});

describe('Explore view — filter the neighborhood (EXPLORE-9)', () => {
  // default neighborhood: Finance (organization, edge "funds", asserted) + Steve (person, no predicate
  // → edge "linked from", speculative). Two kinds, two edge types, one speculative → a real filter bar.
  const names = (c: HTMLElement): (string | null)[] => Array.from(c.querySelectorAll('.explore-neighbor-name')).map((n) => n.textContent);

  it('renders a filter bar with chips for the distinct kinds, edge types, and a hide-speculative toggle', async () => {
    const c = await mount();
    expect(c.querySelector('.explore-filters')).not.toBeNull();
    const kinds = Array.from(c.querySelectorAll('.explore-filter-chip[data-group="kind"]')).map((b) => b.getAttribute('data-value'));
    expect(kinds.sort()).toEqual(['organization', 'person']);
    const edges = Array.from(c.querySelectorAll('.explore-filter-chip[data-group="edge"]')).map((b) => b.getAttribute('data-value'));
    expect(edges.sort()).toEqual(['funds', 'linked from']);
    expect(c.querySelector('.explore-filter-chip[data-group="spec"]')).not.toBeNull();
    expect(c.querySelectorAll('select')).toHaveLength(0); // instrument language, no native dropdown (EXPLORE-10)
  });

  it('clicking an entity-kind chip narrows to that kind; clicking again clears it', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="kind"][data-value="person"]')!.click();
    expect(names(c)).toEqual(['Steve Park']);
    expect(c.querySelector('.explore-filter-chip[data-group="kind"][data-value="person"]')?.getAttribute('aria-pressed')).toBe('true');
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="kind"][data-value="person"]')!.click();
    expect(names(c).sort()).toEqual(['Finance Team', 'Steve Park']);
  });

  it('"hide speculative" drops low-confidence edges (the optional confidence filter)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="spec"]')!.click();
    expect(names(c)).toEqual(['Finance Team']); // Steve (speculative) hidden
  });

  it('filters across groups are ANDed (kind AND edge type)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="kind"][data-value="organization"]')!.click();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="edge"][data-value="funds"]')!.click();
    expect(names(c)).toEqual(['Finance Team']);
  });

  it('a filter combination that matches nothing shows a clear message + a clear-filters affordance', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="kind"][data-value="person"]')!.click();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="edge"][data-value="funds"]')!.click();
    expect(c.querySelector('.explore-filter-none')).not.toBeNull();
    expect(c.querySelectorAll('.explore-neighbor')).toHaveLength(0);
    c.querySelector<HTMLButtonElement>('.explore-filter-none .explore-filter-clear')!.click();
    expect(names(c).sort()).toEqual(['Finance Team', 'Steve Park']); // cleared → all back
  });

  it('shows no filter bar for a trivial neighborhood (nothing to narrow)', async () => {
    exploreNeighborhood = vi.fn(async () =>
      neighborhood({ neighbors: [{ rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.8, direction: 'out', speculative: false }], shown: 1, total: 1 }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelector('.explore-filters')).toBeNull();
  });

  it('a fresh re-center resets active filters (filters are scoped to one neighborhood)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-filter-chip[data-group="spec"]')!.click();
    expect(names(c)).toEqual(['Finance Team']);
    c.querySelector<HTMLButtonElement>('.explore-recenter[data-rel="entities/org/finance.md"]')!.click();
    await flush();
    expect(c.querySelectorAll('.explore-filter-chip[aria-pressed="true"]')).toHaveLength(0); // filters cleared on re-center
  });
});

describe('Explore view — expand-in-place (EXPLORE-7)', () => {
  const subFor = (): ExploreNeighborhood =>
    neighborhood({
      center: { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, tags: [] },
      neighbors: [{ rel: 'entities/x/sub.md', id: 'x', name: 'Sub Entity', kind: 'concept', confidence: 0.8, direction: 'out', predicate: 'reports to', speculative: false }],
      shown: 1,
      total: 1,
    });

  it('expanding a neighbor reveals its own links inline without changing focus', async () => {
    exploreNeighborhood = vi.fn(async (focus?: string) => (focus === 'entities/org/finance.md' ? subFor() : neighborhood()));
    setApi();
    const c = await mount();
    const expand = c.querySelector<HTMLButtonElement>('.explore-expand[data-rel="entities/org/finance.md"]')!;
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expand.click();
    await flush();
    await flush();
    const sub = c.querySelector('.explore-subneighbors');
    expect(sub).not.toBeNull();
    expect(sub!.textContent).toContain('Sub Entity');
    expect(c.querySelector('.explore-expand[data-rel="entities/org/finance.md"]')?.getAttribute('aria-expanded')).toBe('true');
    // focus is unchanged — center still the original entity, no breadcrumb pushed
    expect(c.querySelector('.explore-center-name')?.textContent).toBe('Project Atlas');
    expect(c.querySelectorAll('.explore-crumb[data-rel]')).toHaveLength(0);
  });

  it('a sub-neighbor is itself click-to-re-center', async () => {
    exploreNeighborhood = vi.fn(async (focus?: string) => (focus === 'entities/org/finance.md' ? subFor() : neighborhood()));
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-expand[data-rel="entities/org/finance.md"]')!.click();
    await flush();
    await flush();
    exploreNeighborhood.mockClear();
    c.querySelector<HTMLButtonElement>('.explore-subneighbor .explore-recenter[data-rel="entities/x/sub.md"]')!.click();
    await flush();
    expect(exploreNeighborhood).toHaveBeenCalledWith('entities/x/sub.md');
  });

  it('collapsing hides the inline links again', async () => {
    exploreNeighborhood = vi.fn(async (focus?: string) => (focus === 'entities/org/finance.md' ? subFor() : neighborhood()));
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-expand[data-rel="entities/org/finance.md"]')!.click();
    await flush();
    await flush();
    expect(c.querySelector('.explore-subneighbors')).not.toBeNull();
    c.querySelector<HTMLButtonElement>('.explore-expand[data-rel="entities/org/finance.md"]')!.click();
    expect(c.querySelector('.explore-subneighbors')).toBeNull();
  });

  it('a failed expand fetch degrades to a calm "no further links", never throws (ENG-16)', async () => {
    exploreNeighborhood = vi.fn(async (focus?: string) => {
      if (focus === 'entities/org/finance.md') throw new Error('ipc down');
      return neighborhood();
    });
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-expand[data-rel="entities/org/finance.md"]')!.click();
    await flush();
    await flush();
    expect(c.querySelector('.explore-subneighbors')?.textContent).toMatch(/no further links/i);
  });
});

describe('Explore view — load resilience', () => {
  it('degrades to a retryable error when the IPC fails (no infinite spinner)', async () => {
    exploreNeighborhood = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
  });
});
