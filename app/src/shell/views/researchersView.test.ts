// @vitest-environment happy-dom
//
// SPEC-0028 RESEARCH-15/17 — "The Field Desk" Researchers Manage view, component tier (happy-dom).
// IPC mocked; we assert the rendered instrument strips, the §6 anti-generic guardrails (custom
// clearance ladder + segmented selectors + tiles, NO native <select>), the risky-change confirm gate,
// the typed dispatch report (found/nothing/failed/paused), add-from-tile, and escaping.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResearchers } from './researchersView';
import type { ResearcherView, KbApi } from '../../kb/types';

const base: Omit<ResearcherView, 'id' | 'template' | 'label' | 'egressTier'> = { prompt: 'find prior art', repoPath: '', prRepo: '', tenantId: '', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: ['atlas'], budget: { maxToolCalls: 8, maxDepth: 2 }, allowedTools: [], lastRun: null };
const webRow: ResearcherView = { ...base, id: 'web-1', template: 'web', label: 'Prior art', egressTier: 'public-web' };
const codeRow: ResearcherView = { ...base, id: 'code-1', template: 'code', label: 'Repo', repoPath: '/repos/app', prRepo: 'octocat/hello-world', egressTier: 'local-only', topics: [] };

let listResearchers: ReturnType<typeof vi.fn>;
let setResearcherConfig: ReturnType<typeof vi.fn>;
let runResearcherNow: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listResearchers: listResearchers as unknown as KbApi['listResearchers'],
    setResearcherConfig: setResearcherConfig as unknown as KbApi['setResearcherConfig'],
    runResearcherNow: runResearcherNow as unknown as KbApi['runResearcherNow'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listResearchers = vi.fn(async () => [webRow]);
  setResearcherConfig = vi.fn(async () => [{ ...webRow, enabled: true }]);
  runResearcherNow = vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'ok' }));
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  await mountResearchers(c);
  await flush();
  return c;
}

describe('Field Desk — render (RESEARCH-15)', () => {
  it('renders one instrument strip per researcher: id + named kind + clearance ladder + reach readout', async () => {
    const c = await mount();
    expect(c.querySelectorAll('.rdesk-strip')).toHaveLength(1);
    expect(c.querySelector('.rdesk-id')?.textContent).toBe('web-1');
    expect(c.querySelector('.rdesk-kind')?.textContent).toContain('Public Web'); // named kind + glyph
    expect(c.querySelectorAll('.rdesk-rung')).toHaveLength(3); // clearance ladder: local · internal · public
    expect(c.querySelector('.rdesk-reach')?.textContent).toContain('budget 8 calls/pass'); // reach readout
  });

  it('the clearance ladder lights the active tier rung (public-web here), others ghosted', async () => {
    const c = await mount();
    const active = c.querySelector('.rdesk-rung[aria-checked="true"]');
    expect(active?.getAttribute('data-tier')).toBe('public-web');
    expect(c.querySelectorAll('.rdesk-rung[aria-checked="true"]')).toHaveLength(1);
  });

  it('a disabled researcher reads PAUSED; the strip carries its clearance + armed state for styling', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip')!;
    expect(strip.getAttribute('data-armed')).toBe('false');
    expect(strip.getAttribute('data-clearance')).toBe('public-web');
    expect(c.querySelector('.rdesk-arm')?.textContent).toContain('PAUSED');
  });

  it('shows the empty state + the add dock when there are no researchers', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    expect(c.querySelector('.rdesk-empty')).not.toBeNull();
    expect(c.querySelectorAll('.rdesk-tile').length).toBeGreaterThan(0);
  });

  it('degrades to a retryable error when listing fails (PANEL-9)', async () => {
    listResearchers = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
  });

  it('renders the last-run as a typed, state-coded report (never a raw slug)', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'research-failed', what: 'Atlas', citations: 0 } }]);
    setApi();
    const c = await mount();
    const report = c.querySelector('.rdesk-report');
    expect(report?.getAttribute('data-state')).toBe('failed'); // failed reads distinctly (oxide), not calm
    expect(report?.textContent).toContain('run failed');
    expect(report?.textContent).not.toContain('research-failed'); // no dev slug
    // AA (KB-Design-Lead #184): the state hue rides the GLYPH flag (a graphic, ≥3:1), not the small
    // 0.82rem body text (which stays --viz-ink at 4.5:1) — so failed is distinct AND legible.
    expect(report?.querySelector('.rdesk-report-flag')).not.toBeNull();
  });
});

describe('Field Desk — §6 anti-generic guardrails (GATE-1 watch-items)', () => {
  it('uses NO native <select> anywhere — kind, clearance, schedule, autonomy are all custom components', async () => {
    listResearchers = vi.fn(async () => [webRow, codeRow]);
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('select')).toHaveLength(0); // the whole point of the redesign
  });

  it('the clearance ladder + segmented selectors are radio-style custom controls', async () => {
    const c = await mount();
    expect(c.querySelector('.rdesk-ladder[role="radiogroup"]')).not.toBeNull();
    expect(c.querySelectorAll('.rdesk-seg [role="radiogroup"]').length).toBe(2); // schedule + autonomy
  });
});

describe('Field Desk — confirm gate (RESEARCH-8/15)', () => {
  it('arming (enable) reveals the consequence-worded confirm, then calls setResearcherConfig', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/reach Public web/i);
    expect(setResearcherConfig).not.toHaveBeenCalled();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', enabled: true });
  });

  it('cancel on arm does not apply', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    expect(setResearcherConfig).not.toHaveBeenCalled();
  });

  it('WIDENING clearance (a less-trusted rung) confirms; clicking the active rung is a no-op', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, egressTier: 'local-only' }]);
    setApi();
    const c = await mount();
    // click the active (local) rung → nothing
    c.querySelector<HTMLButtonElement>('.rdesk-rung[data-tier="local-only"]')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(true);
    // widen to public → confirm
    c.querySelector<HTMLButtonElement>('.rdesk-rung[data-tier="public-web"]')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/widen/i);
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', egressTier: 'public-web' });
  });

  it('schedule change applies directly (steering, no confirm)', async () => {
    const c = await mount();
    const daily = Array.from(c.querySelectorAll<HTMLButtonElement>('.researcher-schedule .rdesk-seg-opt')).find((b) => b.dataset.value === 'daily')!;
    daily.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', schedule: 'daily' });
  });

  it('autonomy → Autonomous confirms', async () => {
    const c = await mount();
    const auto = Array.from(c.querySelectorAll<HTMLButtonElement>('.researcher-posture .rdesk-seg-opt')).find((b) => b.dataset.value === 'autonomous')!;
    auto.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/autonomous/i);
  });
});

describe('Field Desk — dispatch → typed report (RESEARCH-15; #160/#180)', () => {
  async function dispatch(c: HTMLElement): Promise<void> {
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
  }

  it('found → "brought back N cited sources"', async () => {
    const c = await mount();
    await dispatch(c);
    expect(runResearcherNow).toHaveBeenCalledWith('web-1');
    expect(c.querySelector('.researcher-status')?.textContent).toMatch(/brought back 1 cited source/i);
  });

  it('a ceiling-blocked dispatch reads PAUSED, never "nothing new" (ceiling ≠ empty, RESEARCH-11)', async () => {
    runResearcherNow = vi.fn(async () => ({ ran: true, sourceIds: [], note: 'ceiling', ceilingReached: true }));
    setApi();
    const c = await mount();
    await dispatch(c);
    const s = c.querySelector('.researcher-status')?.textContent ?? '';
    expect(s).toMatch(/paused/i);
    expect(s).toMatch(/rate limit/i);
    expect(s).not.toMatch(/nothing new/i);
  });

  it('a failed dispatch reads as an error, never empty (failed ≠ empty, #160)', async () => {
    runResearcherNow = vi.fn(async () => ({ ran: true, sourceIds: [], note: 'fail', failed: true, error: 'spawn copilot ENOENT' }));
    setApi();
    const c = await mount();
    await dispatch(c);
    const s = c.querySelector('.researcher-status')?.textContent ?? '';
    expect(s).toMatch(/couldn't run/i);
    expect(s).toMatch(/ENOENT/);
    expect(s).not.toMatch(/nothing new/i);
  });
});

describe('Field Desk — add via named tile', () => {
  it('pick a tile + name + re-click creates a DISARMED researcher with the chosen template + slug id', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const codeTile = c.querySelector<HTMLButtonElement>('.rdesk-tile[data-template="code"]')!;
    codeTile.click(); // select
    expect(codeTile.getAttribute('aria-pressed')).toBe('true');
    (c.querySelector<HTMLInputElement>('.researcher-add-id')!).value = 'My Repo Reader';
    codeTile.click(); // re-click the chosen tile = dispatch
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'my-repo-reader', template: 'code', egressTier: 'local-only', enabled: false });
  });

  it('add with an empty name asks for one (no IPC call)', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const tile = c.querySelector<HTMLButtonElement>('.rdesk-tile[data-template="web"]')!;
    tile.click();
    tile.click(); // re-click with empty name
    await flush();
    expect(setResearcherConfig).not.toHaveBeenCalled();
    expect(c.querySelector('.researcher-add-status')?.textContent).toMatch(/name/i);
  });
});

describe('Field Desk — XSS safety', () => {
  it('escapes a hostile researcher label/id', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, id: 'web-1', label: '<img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
  });
});
