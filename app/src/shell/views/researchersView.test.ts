// @vitest-environment happy-dom
//
// SPEC-0028 RESEARCH-15 — the Researchers Manage view, component tier (happy-dom). IPC mocked; we
// assert the rendered DOM, the risky-change confirm gate, run-now, add-from-template, and escaping.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResearchers } from './researchersView';
import type { ResearcherView, KbApi } from '../../kb/types';

const webRow: ResearcherView = { id: 'web-1', template: 'web', label: 'Prior art', egressTier: 'public-web', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: ['atlas'], lastRun: null };

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

describe('Researchers view (RESEARCH-15)', () => {
  it('renders a row per researcher with its template + egress + last-run', async () => {
    const c = await mount();
    expect(c.querySelectorAll('.researcher')).toHaveLength(1);
    expect(c.querySelector('.researcher-label')?.textContent).toBe('Prior art');
    expect(c.querySelector('.researcher-template')?.textContent).toBe('web');
    expect(c.textContent).toContain('Public web');
    expect(c.querySelector('.researcher-lastrun')?.textContent).toContain('Never run');
  });

  it('shows an empty state + the add form when there are no researchers', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    expect(c.querySelector('.researcher-empty')).not.toBeNull();
    expect(c.querySelector('.researcher-add')).not.toBeNull();
  });

  it('degrades to a friendly error when listing fails (PANEL-9)', async () => {
    listResearchers = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.error')).not.toBeNull();
  });
});

describe('confirm gate (RESEARCH-15)', () => {
  it('enabling a researcher requires confirm, then calls setResearcherConfig', async () => {
    const c = await mount();
    const toggle = c.querySelector<HTMLInputElement>('.researcher-enabled')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    // confirm revealed, not yet applied
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(setResearcherConfig).not.toHaveBeenCalled();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', enabled: true });
  });

  it('cancel reverts the toggle without applying', async () => {
    const c = await mount();
    const toggle = c.querySelector<HTMLInputElement>('.researcher-enabled')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    expect(setResearcherConfig).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(false); // reverted
  });
});

describe('run-now + add-from-template', () => {
  it('run-now confirms then calls runResearcherNow and surfaces the outcome', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(runResearcherNow).toHaveBeenCalledWith('web-1');
    expect(c.querySelector('.researcher-status')?.textContent).toContain('added 1 cited source');
  });

  it('add-from-template creates a disabled researcher with the chosen id', async () => {
    const c = await mount();
    (c.querySelector<HTMLSelectElement>('.researcher-add-template')!).value = 'web';
    (c.querySelector<HTMLInputElement>('.researcher-add-id')!).value = 'web-2';
    c.querySelector<HTMLButtonElement>('.researcher-add-btn')!.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-2', template: 'web', egressTier: 'public-web', enabled: false });
  });

  it('add with an empty id asks for one (no IPC call)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-add-btn')!.click();
    await flush();
    expect(setResearcherConfig).not.toHaveBeenCalled();
    expect(c.querySelector('.researcher-add-status')?.textContent).toMatch(/id/);
  });
});

describe('XSS-safety', () => {
  it('escapes hostile researcher labels', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, label: '<img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('.researcher-label')?.textContent).toContain('<img');
  });
});
