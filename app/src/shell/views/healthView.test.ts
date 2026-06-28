// @vitest-environment happy-dom
//
// SPEC-0035 HEALTH — the Health view, component tier (happy-dom; IPC mocked). Asserts the calm summary
// readout, the dead-links / orphans / thin-pages sections, click-through (openCitation), the "+N more"
// overflow, the all-clear empty state, ENG-15/16 partial-data render safety, and load resilience.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountHealth } from './healthView';
import type { KbApi } from '../../kb/types';
import type { HealthReport } from '../../kb/healthPanel';

function report(over: Partial<HealthReport> = {}): HealthReport {
  return {
    scanned: 10,
    orphans: [{ rel: 'entities/x/lonely.md', id: 'l', name: 'Lonely', kind: 'concept' }],
    thin: [{ rel: 'entities/x/stub.md', id: 's', name: 'Stub', kind: 'person' }],
    dangling: [{ from: 'entities/person/ada.md', fromName: 'Ada Lovelace', target: 'entities/ghost/missing.md' }],
    counts: { orphans: 1, thin: 1, dangling: 1 },
    ...over,
  };
}

let healthReport: ReturnType<typeof vi.fn>;
let openCitation: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    healthReport: healthReport as unknown as KbApi['healthReport'],
    openCitation: openCitation as unknown as KbApi['openCitation'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  healthReport = vi.fn(async () => report());
  openCitation = vi.fn(async () => ({ ok: true as const }));
  setApi();
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  await mountHealth(c);
  await flush();
  return c;
}

describe('Health view — readout (HEALTH-8)', () => {
  it('renders the calm summary line with the three metrics + scanned count', async () => {
    const c = await mount();
    const sum = c.querySelector('.health-summary')?.textContent ?? '';
    expect(sum).toMatch(/1 dead link/);
    expect(sum).toMatch(/1 orphan/);
    expect(sum).toMatch(/1 thin page/);
    expect(sum).toMatch(/10 entities/);
  });

  it('renders a section per issue kind with its findings', async () => {
    const c = await mount();
    const heads = Array.from(c.querySelectorAll('.health-section-head')).map((h) => h.textContent?.trim());
    expect(heads.some((h) => h?.startsWith('Dead links'))).toBe(true);
    expect(heads.some((h) => h?.startsWith('Orphans'))).toBe(true);
    expect(heads.some((h) => h?.startsWith('Thin pages'))).toBe(true);
    expect(c.querySelector('.health-finding--dangling .health-dead-target')?.textContent).toBe('entities/ghost/missing.md');
    expect(Array.from(c.querySelectorAll('.health-finding-name')).map((n) => n.textContent)).toEqual(
      expect.arrayContaining(['Ada Lovelace', 'Lonely', 'Stub']),
    );
  });

  it('clicking a finding opens the node via openCitation (leads back to reading)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.health-open[data-rel="entities/x/lonely.md"]')!.click();
    expect(openCitation).toHaveBeenCalledWith('entities/x/lonely.md');
  });

  it('shows a "+N more" note when a category exceeds the shown list', async () => {
    healthReport = vi.fn(async () =>
      report({ orphans: [{ rel: 'entities/x/a.md', id: 'a', name: 'A', kind: 'concept' }], counts: { orphans: 9, thin: 0, dangling: 0 }, thin: [], dangling: [] }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelector('.health-more')?.textContent).toContain('+8 more');
  });

  it('the all-clear state reads calm, not a wall of red (no empty sections)', async () => {
    healthReport = vi.fn(async () => report({ orphans: [], thin: [], dangling: [], counts: { orphans: 0, thin: 0, dangling: 0 } }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.health-summary--clean')?.textContent).toMatch(/all clear/i);
    expect(c.querySelector('.health-allclear')).not.toBeNull();
    expect(c.querySelectorAll('.health-section')).toHaveLength(0);
  });

  it('partial data: a finding missing name/kind renders without breaking siblings (ENG-15/16)', async () => {
    healthReport = vi.fn(async () =>
      report({
        orphans: [
          { rel: 'entities/x/partial.md', id: 'p', name: '', kind: '' }, // legacy/partial row
          { rel: 'entities/x/lonely.md', id: 'l', name: 'Lonely', kind: 'concept' },
        ],
        thin: [],
        dangling: [],
        counts: { orphans: 2, thin: 0, dangling: 0 },
      }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.health-finding')).toHaveLength(2); // both render, no crash
    expect(c.querySelector('.health-open[data-rel="entities/x/partial.md"]')).not.toBeNull();
  });

  it('degrades to a retryable error when the scan IPC fails (no endless spinner)', async () => {
    healthReport = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
  });
});
