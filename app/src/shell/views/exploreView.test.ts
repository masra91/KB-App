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
    claims: [{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8 }],
    neighbors: [
      { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out' },
      { rel: 'entities/person/steve.md', id: 's', name: 'Steve Park', kind: 'person', confidence: 0.6, direction: 'in' },
    ],
    shown: 2,
    total: 2,
    ...over,
  };
}

let exploreNeighborhood: ReturnType<typeof vi.fn>;
let exploreEntities: ReturnType<typeof vi.fn>;
let openCitation: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    exploreNeighborhood: exploreNeighborhood as unknown as KbApi['exploreNeighborhood'],
    exploreEntities: exploreEntities as unknown as KbApi['exploreEntities'],
    openCitation: openCitation as unknown as KbApi['openCitation'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  exploreNeighborhood = vi.fn(async () => neighborhood());
  exploreEntities = vi.fn(async () => ENTITIES);
  openCitation = vi.fn(async () => ({ ok: true as const }));
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
      neighborhood({ neighbors: [{ rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out' }], shown: 1, total: 9 }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelector('.explore-more')?.textContent).toContain('+8 more');
    expect(c.querySelector('.explore-neighbors-head')?.textContent).toContain('1/9');
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
