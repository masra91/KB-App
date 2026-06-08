// @vitest-environment happy-dom
//
// SPEC-0028 RESEARCH-15/17 — "The Field Desk" Researchers Manage view, component tier (happy-dom).
// IPC mocked; we assert the rendered instrument strips, the §6 anti-generic guardrails (custom
// clearance ladder + segmented selectors + tiles, NO native <select>), the risky-change confirm gate,
// the typed dispatch report (found/nothing/failed/paused), add-from-tile, and escaping.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResearchers } from './researchersView';
import type { ResearcherView, KbApi } from '../../kb/types';

const base: Omit<ResearcherView, 'id' | 'template' | 'label' | 'egressTier'> = { prompt: 'find prior art', repoPath: '', prRepo: '', tenantId: '', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: ['atlas'], budget: { maxToolCalls: 8, maxDepth: 2 }, timeoutMs: 15 * 60_000, orientBudget: 5, allowedTools: [], lastRun: null };
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
    expect(c.querySelector<HTMLInputElement>('.rdesk-reach .researcher-maxcalls')?.value).toBe('8'); // editable budget (WS3)
    expect(c.querySelector<HTMLInputElement>('.rdesk-reach .researcher-maxdepth')?.value).toBe('2'); // editable depth (WS3 Slice-2)
    expect(c.querySelector('.rdesk-reach-ro')?.textContent).toContain('tools:'); // read-only tail = the tool allowlist
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

describe('Field Desk — escalation deep-link (RESEARCH-11; no dead affordance)', () => {
  const escalatedRow: ResearcherView = { ...webRow, lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'escalated', what: 'Atlas', citations: 0, reviewId: 'REV123' } };

  it('an escalated last-run renders an actionable "open review" link; a non-escalated one does NOT', async () => {
    listResearchers = vi.fn(async () => [escalatedRow]);
    setApi();
    const c = await mount();
    const link = c.querySelector<HTMLButtonElement>('.rdesk-review-link');
    expect(link).not.toBeNull(); // the escalation is actionable, not just a status line
    expect(link?.dataset.reviewId).toBe('REV123');
    // a ceiling-reached pause has no Review to open → no link
    listResearchers = vi.fn(async () => [{ ...webRow, lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'ceiling-reached', what: 'Atlas', citations: 0 } }]);
    setApi();
    const c2 = await mount();
    expect(c2.querySelector('.rdesk-review-link')).toBeNull();
  });

  it('clicking "open review" navigates to the Reviews view (dispatches kb:navigate)', async () => {
    listResearchers = vi.fn(async () => [escalatedRow]);
    setApi();
    const c = await mount();
    let navigatedTo: string | null = null;
    document.addEventListener('kb:navigate', (e) => (navigatedTo = (e as CustomEvent).detail?.view), { once: true });
    c.querySelector<HTMLButtonElement>('.rdesk-review-link')!.click();
    expect(navigatedTo).toBe('reviews'); // VIEW_REVIEWS — opens the queue where the Review awaits
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

describe('Field Desk — WS2: composes the shared design-system primitives (DESIGN-SYS)', () => {
  // The migration hoists the inline controls onto the canonical shared primitives (one source of
  // truth) WITHOUT changing behavior — so Jobs/Reviews compose the same kit. These assert the
  // primitive classes + their a11y contracts (the §9 GATE-2 watch-items) are on the rendered markup.
  it('SegmentedControl — schedule/autonomy are .viz-seg-opt in a .viz-seg radiogroup (neutral variant)', async () => {
    const c = await mount();
    const groups = Array.from(c.querySelectorAll('.viz-seg[role="radiogroup"]'));
    // ladder + schedule + autonomy all use the shared .viz-seg group
    expect(groups.length).toBe(3);
    const schedule = c.querySelector('.researcher-schedule');
    expect(schedule?.classList.contains('viz-seg')).toBe(true);
    expect(schedule?.getAttribute('role')).toBe('radiogroup');
    const opt = schedule?.querySelector('.viz-seg-opt');
    expect(opt).not.toBeNull();
    expect(opt?.getAttribute('role')).toBe('radio'); // proper radio semantics, not a <select>
    expect(opt?.hasAttribute('aria-checked')).toBe(true);
    // neutral segments are NOT clearance-tinted
    expect(c.querySelector('.researcher-schedule .viz-seg-opt--clearance')).toBeNull();
  });

  it('SegmentedControl — clearance ladder rungs are .viz-seg-opt--clearance carrying data-temp (hue+position, not color-only)', async () => {
    const c = await mount();
    const rungs = Array.from(c.querySelectorAll('.rdesk-ladder .viz-seg-opt--clearance'));
    expect(rungs).toHaveLength(3);
    // the active rung reads via aria-checked AND data-temp (consequence hue reinforced by the checked state)
    const active = c.querySelector('.rdesk-ladder .viz-seg-opt[aria-checked="true"]');
    expect(active?.getAttribute('data-temp')).toBe('public-web');
  });

  it('ConfirmInline — the confirm box composes .viz-confirm / __msg, and the confirm action is a .viz-btn--danger', async () => {
    const c = await mount();
    const confirm = c.querySelector('.researcher-confirm');
    expect(confirm?.classList.contains('viz-confirm')).toBe(true);
    expect(c.querySelector('.researcher-confirm-msg')?.classList.contains('viz-confirm__msg')).toBe(true);
    const go = c.querySelector('.researcher-confirm-go');
    expect(go?.classList.contains('viz-btn')).toBe(true);
    expect(go?.classList.contains('viz-btn--danger')).toBe(true); // destructive = oxide border (text stays ink, §2)
  });

  it('EditableField — the orders box is a .viz-field__input--multiline; captioned fields are .viz-field with .viz-field__input', async () => {
    listResearchers = vi.fn(async () => [codeRow]); // code row renders repo/PR fields too
    setApi();
    const c = await mount();
    const prompt = c.querySelector('.researcher-prompt');
    expect(prompt?.classList.contains('viz-field__input')).toBe(true);
    expect(prompt?.classList.contains('viz-field__input--multiline')).toBe(true);
    const field = c.querySelector('.rdesk-field.viz-field');
    expect(field).not.toBeNull();
    expect(field?.querySelector('.viz-field__label')).not.toBeNull(); // a real labelled control
    expect(field?.querySelector('input.viz-field__input')).not.toBeNull();
  });

  it('Button busy — dispatching toggles .viz-btn--busy on the run Button (then clears on completion)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    const run = c.querySelector<HTMLButtonElement>('.researcher-run')!;
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click(); // dispatch starts
    expect(run.classList.contains('viz-btn--busy')).toBe(true); // ember breathe while in-flight
    await flush(); // dispatch resolves → re-render; the fresh run button is no longer busy
    expect(c.querySelector('.researcher-run')?.classList.contains('viz-btn--busy')).toBe(false);
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

  // WS1 #1: cancelling/confirming must DISMISS the confirm box and CLEAR its message. (The CSS `[hidden]`
  // guard that lets `hidden` actually hide it is asserted in confirmDismissCss.test.ts — happy-dom
  // applies no stylesheet, so the renderer contract verified here is the `hidden` attribute + cleared text.)
  it('REGRESSION (#1): cancelling the confirm hides it AND clears the stale prompt text', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    const confirm = c.querySelector<HTMLElement>('.researcher-confirm')!;
    expect(confirm.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).not.toBe('');
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    expect(confirm.hidden).toBe(true);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toBe(''); // no lingering message
  });
});

describe('Field Desk — WS1 fixes (#2 honest eligibility, #6 real-name confirm)', () => {
  it("REGRESSION (#2): an enabled researcher with schedule 'off' surfaces that it still runs on demand", async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, enabled: true, schedule: 'off' as const }]);
    setApi();
    const c = await mount();
    const elig = c.querySelector('.researcher-eligibility');
    expect(elig?.getAttribute('data-will-run')).toBe('true');
    expect(elig?.textContent).toMatch(/on demand/i);
    expect(elig?.textContent).not.toMatch(/won't run/i);
  });

  it('a disabled (PAUSED) researcher surfaces that it will not run', async () => {
    const c = await mount(); // webRow is enabled:false
    const elig = c.querySelector('.researcher-eligibility');
    expect(elig?.getAttribute('data-will-run')).toBe('false');
    expect(elig?.textContent).toMatch(/won't run|paused/i);
  });

  it("REGRESSION (#6): the run-now confirm names the researcher, not the generic template word", async () => {
    // A bare code researcher whose name (id) the panel surfaced as the label — the confirm must say its
    // name, never "code". (webRow-style row with a code template + name-as-label.)
    listResearchers = vi.fn(async () => [{ ...codeRow, label: 'azure-sdk-repo' }]);
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    const msg = c.querySelector('.researcher-confirm-msg')?.textContent ?? '';
    expect(msg).toContain('azure-sdk-repo');
    expect(msg).not.toMatch(/“code”|"code"/); // not the generic template word
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

describe('Field Desk — WS3/warm-start editable budget + timeout + orient + depth (RESEARCH-15/18/22/11)', () => {
  it('renders editable reads/pass + orient/pass + timeout + depth fields seeded from the view-model', async () => {
    const c = await mount(); // webRow: budget.maxToolCalls 8, maxDepth 2, timeoutMs 15min, orientBudget 5
    const calls = c.querySelector<HTMLInputElement>('.researcher-maxcalls');
    const orient = c.querySelector<HTMLInputElement>('.researcher-orient');
    const timeout = c.querySelector<HTMLInputElement>('.researcher-timeout');
    const depth = c.querySelector<HTMLInputElement>('.researcher-maxdepth');
    expect(calls?.value).toBe('8');
    expect(orient?.value).toBe('5'); // orient budget (warm-start)
    expect(timeout?.value).toBe('15'); // 15 min
    expect(depth?.value).toBe('2'); // maxDepth (WS3 Slice-2)
    // They use the WS2 EditableField primitive (viz-field__input), not bespoke chrome.
    expect(calls?.classList.contains('viz-field__input')).toBe(true);
    expect(orient?.classList.contains('viz-field__input')).toBe(true);
    expect(timeout?.classList.contains('viz-field__input')).toBe(true);
    expect(depth?.classList.contains('viz-field__input')).toBe(true);
  });

  it('editing orient/pass persists via setResearcherConfig({orientBudget}) (warm-start, RESEARCH-22)', async () => {
    const c = await mount();
    const orient = c.querySelector<HTMLInputElement>('.researcher-orient')!;
    orient.value = '8';
    orient.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', orientBudget: 8 });
  });

  it('editing reads/pass persists via setResearcherConfig({maxToolCalls})', async () => {
    const c = await mount();
    const calls = c.querySelector<HTMLInputElement>('.researcher-maxcalls')!;
    calls.value = '40';
    calls.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', maxToolCalls: 40 });
  });

  it('editing timeout persists via setResearcherConfig({timeoutMs}) — minutes → ms', async () => {
    const c = await mount();
    const timeout = c.querySelector<HTMLInputElement>('.researcher-timeout')!;
    timeout.value = '25';
    timeout.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', timeoutMs: 25 * 60_000 });
  });

  it('editing depth persists via setResearcherConfig({maxDepth}) (WS3 Slice-2, RESEARCH-11)', async () => {
    const c = await mount();
    const depth = c.querySelector<HTMLInputElement>('.researcher-maxdepth')!;
    depth.value = '4';
    depth.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', maxDepth: 4 });
  });

  it('the tool allowlist stays READ-ONLY — reads/pass + orient + timeout + depth are editable (security/scope)', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, allowedTools: ['fetch', 'web_search'], budget: { maxToolCalls: 8, maxDepth: 2 } }]);
    setApi();
    const c = await mount();
    // FOUR editable number inputs in the reach readout (reads/pass + orient + timeout + depth) — never one for tools.
    expect(c.querySelectorAll('.rdesk-reach input').length).toBe(4);
    const ro = c.querySelector('.rdesk-reach-ro');
    expect(ro?.textContent).toMatch(/tools: fetch · web_search/); // allowlist shown as read-only text
    expect(ro?.querySelector('input')).toBeNull(); // no editable control for the tool allowlist (security surface)
  });
});
