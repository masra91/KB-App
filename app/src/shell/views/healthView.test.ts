// @vitest-environment happy-dom
//
// SPEC-0035 HEALTH — the Health view, component tier (happy-dom; IPC mocked). Asserts the gauge-group
// instrument anatomy (DL-2): the top summary strip, three always-present groups with per-group healthy
// lines, the specific defect text per class, severity-as-graphic (#184: hue on the tick/count, not the
// name), click-through (openCitation), "+N more", ENG-15/16 partial-data safety, and load resilience.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountHealth } from './healthView';
import { TimeoutError } from '../loadGuard';
import type { KbApi } from '../../kb/types';
import type { HealthReport } from '../../kb/healthPanel';

function report(over: Partial<HealthReport> = {}): HealthReport {
  return {
    scanned: 10,
    orphans: [{ rel: 'entities/x/lonely.md', id: 'l', name: 'Lonely', kind: 'concept' }],
    thin: [{ rel: 'entities/x/stub.md', id: 's', name: 'Stub', kind: 'person', chars: 42 }],
    dangling: [{ from: 'entities/person/ada.md', fromName: 'Ada Lovelace', target: 'entities/ghost/missing.md' }],
    counts: { orphans: 1, thin: 1, dangling: 1 },
    ...over,
  };
}

let healthReport: ReturnType<typeof vi.fn>;
let openCitation: ReturnType<typeof vi.fn>;
let reportRendererError: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    healthReport: healthReport as unknown as KbApi['healthReport'],
    openCitation: openCitation as unknown as KbApi['openCitation'],
    reportRendererError: reportRendererError as unknown as KbApi['reportRendererError'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  healthReport = vi.fn(async () => report());
  openCitation = vi.fn(async () => ({ ok: true as const }));
  reportRendererError = vi.fn(async () => {});
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

describe('Health view — gauge-group readout (HEALTH-8, DL-2 anatomy)', () => {
  it('renders the top summary strip with the total + scanned count', async () => {
    const c = await mount();
    const sum = c.querySelector('.health-summary')?.textContent ?? '';
    expect(sum).toMatch(/3 structural issues/);
    expect(sum).toMatch(/scanned/);
    expect(sum).toMatch(/10 entities/);
  });

  it('always renders the three gauge groups (never a blank panel), each with its label + count', async () => {
    const c = await mount();
    const groups = Array.from(c.querySelectorAll('.health-group'));
    expect(groups).toHaveLength(3);
    expect(Array.from(c.querySelectorAll('.health-group-label')).map((l) => l.textContent)).toEqual(['Dead links', 'Orphans', 'Thin pages']);
  });

  it('renders the specific defect text per issue class', async () => {
    const c = await mount();
    const defects = Array.from(c.querySelectorAll('.health-defect')).map((d) => d.textContent);
    expect(defects).toContain('→ entities/ghost/missing.md (no node)'); // dead link
    expect(defects).toContain('0 in · 0 out'); // orphan
    expect(defects).toContain('stub · 42 chars'); // thin (uses the panel's char count)
  });

  it('severity is hue on the graphic, not the name (#184): tick/count carry the state class, name does not', async () => {
    const c = await mount();
    const orphanGroup = Array.from(c.querySelectorAll('.health-group')).find((g) => g.querySelector('.health-group-label')?.textContent === 'Orphans')!;
    expect(orphanGroup.querySelector('.health-count')?.classList.contains('viz-state-blocked')).toBe(true); // issues → brass
    const name = orphanGroup.querySelector('.health-finding-name')!;
    expect(name.classList.contains('viz-state-blocked')).toBe(false);
    expect(name.classList.contains('viz-state-settled')).toBe(false); // name stays plain ink
  });

  it('a clean group shows a patina healthy line, not a blank section', async () => {
    healthReport = vi.fn(async () => report({ dangling: [], counts: { orphans: 1, thin: 1, dangling: 0 } }));
    setApi();
    const c = await mount();
    const deadGroup = Array.from(c.querySelectorAll('.health-group')).find((g) => g.querySelector('.health-group-label')?.textContent === 'Dead links')!;
    const healthy = deadGroup.querySelector('.health-healthy')!;
    expect(healthy.textContent).toMatch(/no dead links/i);
    expect(healthy.classList.contains('viz-state-settled')).toBe(true); // patina = settled/ok
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

  it('the all-clear state: summary reads clear + every group shows its healthy line (no issue rows)', async () => {
    healthReport = vi.fn(async () => report({ orphans: [], thin: [], dangling: [], counts: { orphans: 0, thin: 0, dangling: 0 } }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.health-summary')?.textContent).toMatch(/all clear/i);
    expect(c.querySelectorAll('.health-healthy')).toHaveLength(3);
    expect(c.querySelectorAll('.health-row')).toHaveLength(0);
  });

  it('partial data: a finding missing a name renders an "(untitled)" fallback without breaking siblings (ENG-15/16)', async () => {
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
    expect(c.querySelectorAll('.health-row')).toHaveLength(2); // both render, no crash
    expect(c.querySelector('.health-open[data-rel="entities/x/partial.md"] .health-untitled')?.textContent).toBe('(untitled)');
  });

  it('degrades to a retryable error when the scan IPC throws a real error (no endless spinner)', async () => {
    healthReport = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
    expect(c.querySelector('.load-warming')).toBeNull(); // a real throw is an ERROR, not warming
  });

  // SPEC-0058 slice-0 — a slow cold-start scan (TimeoutError) must read as WARMING, not the alarming
  // "Couldn't load" error face (the packaged Health P0: a cold/large-vault scan flipped straight to error).
  it('shows the calm WARMING face (not the error face) when the scan times out', async () => {
    healthReport = vi.fn(async () => {
      throw new TimeoutError(30000); // the generous graph bound tripped → still warming
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-warming')).not.toBeNull(); // PASSES-AFTER
    expect(c.querySelector('.load-error, .error')).toBeNull(); // FAILS-BEFORE: timeout went to the error face
    expect(c.textContent).not.toContain('Couldn’t load');
  });

  // SPEC-0058 slice-0 — the bare `catch {}` swallowed the real cause; both failure paths must now
  // un-swallow it to the app-log so a packaged-app walkthrough can tell timeout from throw.
  it('un-swallows BOTH a timeout and a real throw to the app-log (reportRendererError)', async () => {
    for (const err of [new TimeoutError(30000), new Error('boom')]) {
      reportRendererError = vi.fn(async () => {});
      healthReport = vi.fn(async () => {
        throw err;
      });
      setApi();
      await mount();
      expect(reportRendererError).toHaveBeenCalledTimes(1); // FAILS-BEFORE: swallowed, never logged
      expect((reportRendererError.mock.calls[0][0] as { message: string }).message).toMatch(/\[health\] load failed/);
      document.body.innerHTML = '';
    }
  });
});
