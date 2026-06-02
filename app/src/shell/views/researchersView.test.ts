// @vitest-environment happy-dom
//
// SPEC-0028 RESEARCH-15 — the Researchers Manage view, component tier (happy-dom). IPC mocked; we
// assert the rendered DOM, the risky-change confirm gate, run-now, add-from-template, and escaping.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResearchers } from './researchersView';
import type { ResearcherView, KbApi } from '../../kb/types';

const webRow: ResearcherView = { id: 'web-1', template: 'web', label: 'Prior art', prompt: 'find prior art', repoPath: '', prRepo: '', tenantId: '', egressTier: 'public-web', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: ['atlas'], lastRun: null };
const codeRow: ResearcherView = { id: 'code-1', template: 'code', label: 'Repo', prompt: 'read the repo', repoPath: '/repos/app', prRepo: 'octocat/hello-world', tenantId: '', egressTier: 'local-only', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: [], lastRun: null };
const m365Row: ResearcherView = { id: 'm365-1', template: 'm365', label: 'WorkIQ', prompt: 'summarize project mail', repoPath: '', prRepo: '', tenantId: 'contoso.onmicrosoft.com', egressTier: 'internal-tenant', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: [], lastRun: null };

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
    expect(c.querySelector('.researcher-template')?.textContent).toBe('Public Web'); // short label (RESEARCH-17)
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

describe('instructions + scope (RESEARCH-17)', () => {
  it('renders the instructions textarea + scope prefilled from the config', async () => {
    const c = await mount();
    expect(c.querySelector<HTMLTextAreaElement>('.researcher-prompt')!.value).toBe('find prior art');
    expect(c.querySelector<HTMLInputElement>('.researcher-scope')!.value).toBe('global');
  });

  it('shows the template SHORT label as a badge + the long description as helper text', async () => {
    const c = await mount();
    expect(c.querySelector('.researcher-template')?.textContent).toBe('Public Web');
    expect(c.querySelector('.researcher-template-desc')?.textContent).toContain('Public-web search');
  });

  it('saves instructions + scope on click — steering, so NO confirm gate', async () => {
    const c = await mount();
    c.querySelector<HTMLTextAreaElement>('.researcher-prompt')!.value = 'look for press releases on Atlas';
    c.querySelector<HTMLInputElement>('.researcher-scope')!.value = 'global';
    c.querySelector<HTMLButtonElement>('.researcher-save')!.click();
    await flush();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(true); // not risky
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', prompt: 'look for press releases on Atlas', scope: 'global' });
  });
});

describe('#108 polish — run-now state machine (PANEL-10) + short option labels', () => {
  it('Run now shows a clear running state on the button itself (disabled + "Running…") then resets', async () => {
    let resolveRun!: (v: { ran: boolean; sourceIds: string[]; note: string }) => void;
    runResearcherNow = vi.fn(() => new Promise((res) => (resolveRun = res)));
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();

    const runBtn = c.querySelector<HTMLButtonElement>('.researcher-run')!;
    expect(runBtn.disabled).toBe(true); // running → disabled
    expect(runBtn.textContent).toBe('Running…'); // …and unmistakably labeled

    resolveRun({ ran: true, sourceIds: ['SRC1'], note: 'ok' });
    await flush();
    // The re-render restores an idle row → "Run now", enabled.
    const after = c.querySelector<HTMLButtonElement>('.researcher-run')!;
    expect(after.disabled).toBe(false);
    expect(after.textContent).toBe('Run now');
  });

  it('resets the button on a failed run so it stays retryable', async () => {
    runResearcherNow = vi.fn(async () => {
      throw new Error('egress blocked');
    });
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    const runBtn = c.querySelector<HTMLButtonElement>('.researcher-run')!;
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.textContent).toBe('Run now');
    expect(c.querySelector('.researcher-status')?.textContent).toContain('failed');
  });

  it('add-template options use short labels with the description as a hover title (declutter)', async () => {
    const c = await mount();
    const webOpt = c.querySelector<HTMLOptionElement>('.researcher-add-template option[value="web"]')!;
    expect(webOpt.textContent).toBe('Public Web'); // short, no " — description" inline
    expect(webOpt.title).toContain('Public-web'); // full gloss available on hover
    expect(c.querySelector<HTMLOptionElement>('.researcher-add-template option[value="code"]')!.textContent).toBe('Local Repository');
    expect(c.querySelector<HTMLOptionElement>('.researcher-add-template option[value="m365"]')!.textContent).toBe('WorkIQ/M365');
  });

  it('egress dropdown options are short labels with a tier hint as title', async () => {
    const c = await mount();
    const opt = c.querySelector<HTMLOptionElement>('.researcher-egress-sel option[value="local-only"]')!;
    expect(opt.textContent).toBe('Local only'); // no parenthetical clutter
    expect(opt.title).toContain('Never leaves this machine');
  });
});

describe('Code researcher repoPath config (Slice 2a)', () => {
  it('shows a repoPath input ONLY for code researchers, prefilled from config', async () => {
    listResearchers = vi.fn(async () => [codeRow]);
    setApi();
    const c = await mount();
    expect(c.querySelector<HTMLInputElement>('.researcher-repopath')!.value).toBe('/repos/app');
  });

  it('a web researcher has no repoPath field (template-specific)', async () => {
    const c = await mount(); // default webRow
    expect(c.querySelector('.researcher-repopath')).toBeNull();
  });

  it('saves repoPath alongside instructions/scope for a code researcher (no confirm)', async () => {
    listResearchers = vi.fn(async () => [codeRow]);
    setApi();
    const c = await mount();
    c.querySelector<HTMLInputElement>('.researcher-repopath')!.value = '/repos/other';
    c.querySelector<HTMLButtonElement>('.researcher-save')!.click();
    await flush();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(true); // steering, not risky
    // a code save carries both code-template fields (repoPath + prRepo), prefilled from config
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'code-1', prompt: 'read the repo', scope: 'global', repoPath: '/repos/other', prRepo: 'octocat/hello-world' });
  });

  it('escapes a hostile repoPath value', async () => {
    listResearchers = vi.fn(async () => [{ ...codeRow, repoPath: '"><img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector<HTMLInputElement>('.researcher-repopath')!.value).toContain('<img');
  });
});

describe('Code researcher prRepo (GitHub PR repo) config (Slice 2b)', () => {
  it('shows a prRepo input ONLY for code researchers, prefilled from config', async () => {
    listResearchers = vi.fn(async () => [codeRow]);
    setApi();
    const c = await mount();
    expect(c.querySelector<HTMLInputElement>('.researcher-prrepo')!.value).toBe('octocat/hello-world');
  });

  it('a web researcher has no prRepo field (template-specific)', async () => {
    const c = await mount(); // default webRow
    expect(c.querySelector('.researcher-prrepo')).toBeNull();
  });

  it('saves prRepo alongside the other code fields (no confirm)', async () => {
    listResearchers = vi.fn(async () => [codeRow]);
    setApi();
    const c = await mount();
    c.querySelector<HTMLInputElement>('.researcher-prrepo')!.value = 'octocat/other-repo';
    c.querySelector<HTMLButtonElement>('.researcher-save')!.click();
    await flush();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(true);
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'code-1', prompt: 'read the repo', scope: 'global', repoPath: '/repos/app', prRepo: 'octocat/other-repo' });
  });

  it('escapes a hostile prRepo value', async () => {
    listResearchers = vi.fn(async () => [{ ...codeRow, prRepo: '"><img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector<HTMLInputElement>('.researcher-prrepo')!.value).toContain('<img');
  });
});

describe('M365 researcher tenant config (Slice 3)', () => {
  it('shows a tenant input ONLY for m365 researchers, prefilled from config', async () => {
    listResearchers = vi.fn(async () => [m365Row]);
    setApi();
    const c = await mount();
    expect(c.querySelector<HTMLInputElement>('.researcher-tenant')!.value).toBe('contoso.onmicrosoft.com');
    expect(c.querySelector('.researcher-repopath')).toBeNull(); // not a code field
  });

  it('a web/code researcher has no tenant field (template-specific)', async () => {
    listResearchers = vi.fn(async () => [codeRow]);
    setApi();
    const c = await mount();
    expect(c.querySelector('.researcher-tenant')).toBeNull();
  });

  it('saves tenantId alongside instructions/scope for an m365 researcher (no confirm — steering)', async () => {
    listResearchers = vi.fn(async () => [m365Row]);
    setApi();
    const c = await mount();
    c.querySelector<HTMLInputElement>('.researcher-tenant')!.value = 'fabrikam.onmicrosoft.com';
    c.querySelector<HTMLButtonElement>('.researcher-save')!.click();
    await flush();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(true);
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'm365-1', prompt: 'summarize project mail', scope: 'global', tenantId: 'fabrikam.onmicrosoft.com' });
  });

  it('escapes a hostile tenant value', async () => {
    listResearchers = vi.fn(async () => [{ ...m365Row, tenantId: '"><img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector<HTMLInputElement>('.researcher-tenant')!.value).toContain('<img');
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

  it('escapes a hostile instructions prompt (no textarea-breakout)', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, prompt: '</textarea><img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector<HTMLTextAreaElement>('.researcher-prompt')!.value).toContain('<img');
  });
});
