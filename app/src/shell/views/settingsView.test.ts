// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-5/7 — the elevated Settings view's autonomy-default control. IPC mocked; we assert
// the per-Instance default renders, that → Autonomous (risky) confirms before persisting and Guarded
// applies directly, and that cancel reverts. (The store + resolver logic is node-tested in
// instanceConfig.test.ts; Replay is covered by SPEC-0022's own tests.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountSettings } from './settingsView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { KbApi, InstanceSettings } from '../../kb/types';

function setApi(autonomyDefault: 'guarded' | 'autonomous', setSpy?: KbApi['setInstanceSettings']): {
  set: ReturnType<typeof vi.fn>;
} {
  const set = vi.fn(setSpy ?? (async (s: InstanceSettings) => s));
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    getState: vi.fn(async () => ({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'KB', createdAt: 't' } })),
    inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
    getInstanceSettings: vi.fn(async () => ({ autonomyDefault, devLogLevel: 'info' as const, quickCaptureAccelerator: 'Alt+Space' })),
    setInstanceSettings: set as KbApi['setInstanceSettings'],
  };
  return { set };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// WS3 (DESIGN-LEGACY-VIEWS §3): the autonomy + dev-log controls are SegmentedControls now — selecting
// is a CLICK (or Space/Enter) on a role=radio segment, not a <select> `change`. These helpers drive that.
const segOpt = (root: HTMLElement, groupId: string, value: string): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(`#${groupId} [role="radio"][data-value="${value}"]`)!;
function pick(root: HTMLElement, groupId: string, value: string): void {
  segOpt(root, groupId, value).click();
}
/** The committed (aria-checked) value of a SegmentedControl. */
function checked(root: HTMLElement, groupId: string): string | null {
  const on = root.querySelector<HTMLElement>(`#${groupId} [role="radio"][aria-checked="true"]`);
  return on?.dataset.value ?? null;
}

describe('Settings · Autonomy default (SPEC-0027 PANEL-5/7)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the current Instance default posture', async () => {
    setApi('guarded');
    await mountSettings(root);
    await tick();
    expect(checked(root, 'autonomy-default')).toBe('guarded');
  });

  it('→ Autonomous confirms before persisting (PANEL-7)', async () => {
    const { set } = setApi('guarded');
    await mountSettings(root);
    await tick();

    pick(root, 'autonomy-default', 'autonomous');
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(checked(root, 'autonomy-default')).toBe('guarded'); // not committed until confirmed

    (root.querySelector('#autonomy-go') as HTMLButtonElement).click();
    await tick();
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' });
    expect(root.querySelector('#autonomy-status')?.textContent).toContain('Autonomous');
    expect(checked(root, 'autonomy-default')).toBe('autonomous'); // now committed
  });

  it('cancelling the confirm reverts the selection and does not persist', async () => {
    const { set } = setApi('guarded');
    await mountSettings(root);
    await tick();
    pick(root, 'autonomy-default', 'autonomous');
    (root.querySelector('#autonomy-cancel') as HTMLButtonElement).click();
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(true);
    expect(checked(root, 'autonomy-default')).toBe('guarded'); // stayed on the saved posture
    expect(set).not.toHaveBeenCalled();
  });

  it('relaxing to Guarded applies directly (no confirm)', async () => {
    const { set } = setApi('autonomous');
    await mountSettings(root);
    await tick();
    pick(root, 'autonomy-default', 'guarded');
    await tick();
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(true);
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' });
    expect(checked(root, 'autonomy-default')).toBe('guarded');
  });
});

describe('Settings · Dev-log verbosity (SPEC-0030 OBS-10)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the current level and persists a change as the FULL settings (autonomy preserved)', async () => {
    const { set } = setApi('autonomous'); // devLogLevel defaults to info
    await mountSettings(root);
    await tick();
    expect(checked(root, 'devlog-level')).toBe('info');

    pick(root, 'devlog-level', 'debug');
    await tick();
    // The whole settings object is sent — autonomyDefault not clobbered (no confirm; benign toggle).
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'debug', quickCaptureAccelerator: 'Alt+Space' });
    expect(root.querySelector('#verbosity-status')?.textContent).toContain('Debug');
    expect(checked(root, 'devlog-level')).toBe('debug');
  });
});

// WS3 migration (DESIGN-LEGACY-VIEWS §3): the native <select>s became SegmentedControls — an
// INTERACTION-CONTRACT change (change-event → role=radiogroup/aria-checked + arrow-key roving focus).
// These guard the contract itself (per the PM dispatch: regression-test it, not just restyle), plus the
// .viz-confirm / .viz-btn--danger composition and the no-legacy-primitive sweep.
describe('Settings · WS3 design-system migration (DESIGN-LEGACY-VIEWS §3 — onto The Line)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders both controls as blessed SegmentedControls (role=radiogroup of role=radio .viz-seg-opt), labelled', async () => {
    setApi('guarded');
    await mountSettings(root);
    await tick();
    for (const [id, labelId] of [['autonomy-default', 'autonomy-label'], ['devlog-level', 'devlog-label']] as const) {
      const group = root.querySelector<HTMLElement>(`#${id}`)!;
      expect(group.classList.contains('viz-seg')).toBe(true);
      expect(group.getAttribute('role')).toBe('radiogroup');
      expect(group.getAttribute('aria-labelledby')).toBe(labelId);
      const radios = group.querySelectorAll('[role="radio"].viz-seg-opt');
      expect(radios).toHaveLength(2);
      radios.forEach((r) => expect(r.getAttribute('aria-checked')).toMatch(/^(true|false)$/));
    }
    expect(root.querySelector('select')).toBeNull(); // the native <select> interaction contract is gone
  });

  it('uses roving tabindex — only the checked segment is the tab stop (§3 a11y)', async () => {
    setApi('guarded');
    await mountSettings(root);
    await tick();
    expect(segOpt(root, 'autonomy-default', 'guarded').tabIndex).toBe(0); // checked → in the tab order
    expect(segOpt(root, 'autonomy-default', 'autonomous').tabIndex).toBe(-1); // unchecked → roved out
  });

  it('roves focus with arrow keys WITHOUT committing; Space/Enter commits (selection ≠ focus)', async () => {
    const { set } = setApi('autonomous'); // devLogLevel = info
    await mountSettings(root);
    await tick();
    const info = segOpt(root, 'devlog-level', 'info');
    const debug = segOpt(root, 'devlog-level', 'debug');
    info.focus();
    info.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // focus + roving tabindex moved to debug, but the selection has NOT changed yet (no save).
    expect(debug.tabIndex).toBe(0);
    expect(info.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(debug);
    expect(checked(root, 'devlog-level')).toBe('info');
    expect(set).not.toHaveBeenCalled();

    debug.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); // commit
    await tick();
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'debug', quickCaptureAccelerator: 'Alt+Space' });
    expect(checked(root, 'devlog-level')).toBe('debug');
  });

  it('composes the blessed .viz-confirm + .viz-btn--danger primitives (autonomy = caution, replay = danger)', async () => {
    setApi('guarded');
    await mountSettings(root);
    await tick();
    const autoConfirm = root.querySelector<HTMLElement>('#autonomy-confirm')!;
    expect(autoConfirm.classList.contains('viz-confirm')).toBe(true);
    expect(autoConfirm.classList.contains('viz-confirm--danger')).toBe(false); // posture change = caution (brass)
    expect(root.querySelector('#autonomy-go')!.classList.contains('viz-btn--danger')).toBe(true);
    expect(root.querySelector('#autonomy-cancel')!.classList.contains('viz-btn')).toBe(true);

    const replayConfirm = root.querySelector<HTMLElement>('#replay-confirm')!;
    expect(replayConfirm.classList.contains('viz-confirm')).toBe(true);
    expect(replayConfirm.classList.contains('viz-confirm--danger')).toBe(true); // destructive → oxide
    expect(root.querySelector('#replay-go')!.classList.contains('viz-btn--danger')).toBe(true);
    expect(root.querySelector('#replay-btn')!.classList.contains('viz-btn--danger')).toBe(true);
  });

  it('carries NO legacy off-system primitives (.muted / legacy .confirm / .btn-danger / native select) on the success path', async () => {
    setApi('autonomous');
    await mountSettings(root);
    await tick();
    expect(root.querySelector('.muted')).toBeNull(); // notes / copilot detail / dt all migrated
    expect(root.querySelector('.confirm')).toBeNull(); // confirms are .viz-confirm now (distinct token)
    expect([...root.querySelectorAll('button')].some((b) => b.classList.contains('btn-danger'))).toBe(false);
    expect([...root.querySelectorAll('button')].some((b) => b.classList.contains('btn'))).toBe(false); // .viz-btn ≠ .btn
    expect(root.querySelector('select')).toBeNull();
  });
});

describe('Settings · #145 load resilience (no infinite spinner on a hung IPC)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('times out a hung getState → retryable error, and Retry re-loads successfully', async () => {
    const getState = vi.fn<KbApi['getState']>().mockReturnValueOnce(new Promise(() => {})); // hangs
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { getState };
    const mounted = mountSettings(root);
    expect(root.textContent).toContain('Loading…'); // spinner initially

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    await mounted;
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.load-error')).toBeTruthy();
    expect(root.querySelector('.load-retry')).toBeTruthy();

    // Retry succeeds → Settings renders.
    getState.mockResolvedValue({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'My KB', createdAt: 't' } });
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      getState,
      inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
      getInstanceSettings: vi.fn(async () => ({ autonomyDefault: 'guarded' as const, devLogLevel: 'info' as const, quickCaptureAccelerator: 'Alt+Space' })),
      setInstanceSettings: vi.fn(async (s: InstanceSettings) => s) as KbApi['setInstanceSettings'],
    };
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain('My KB');
  });
});

describe('Settings · Prepare for shutdown (SPEC-0045 QUIESCE-1/3/5/6)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  function setQuiesceApi(over: Partial<KbApi> = {}): { quiesce: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } {
    const quiesce = vi.fn(async () => ({ quiescing: true, remaining: 3, safe: false, detail: 'Finishing up — 3 tasks remaining…' }));
    const resume = vi.fn(async () => ({ quiescing: false, remaining: 0, safe: false, detail: 'Running normally.' }));
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      getState: vi.fn(async () => ({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'KB', createdAt: 't' } })),
      inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
      getInstanceSettings: vi.fn(async () => ({ autonomyDefault: 'guarded' as const, devLogLevel: 'info' as const, quickCaptureAccelerator: 'Alt+Space' })),
      quiesceStatus: vi.fn(async () => ({ quiescing: false, remaining: 0, safe: false, detail: 'Running normally.' })) as KbApi['quiesceStatus'],
      quiesce: quiesce as KbApi['quiesce'],
      resume: resume as KbApi['resume'],
      ...over,
    };
    return { quiesce, resume };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('the "Prepare for shutdown" button is a modest, non-danger control (QUIESCE-6)', async () => {
    setQuiesceApi();
    await mountSettings(root);
    await tick();
    const btn = root.querySelector('#quiesce-btn')!;
    expect(btn.textContent).toMatch(/Prepare for shutdown/i);
    expect(btn.classList.contains('viz-btn--danger')).toBe(false); // not destructive-styled
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(true);
  });

  it('clicking Prepare quiesces + shows the drain status + Resume (QUIESCE-1/3)', async () => {
    const { quiesce } = setQuiesceApi();
    await mountSettings(root);
    await tick();
    (root.querySelector('#quiesce-btn') as HTMLButtonElement).click();
    await tick();
    expect(quiesce).toHaveBeenCalled();
    expect(root.querySelector('#quiesce-status')!.textContent).toMatch(/3 tasks remaining/i);
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#quiesce-btn') as HTMLElement).hidden).toBe(true);
  });

  it('Resume un-pauses, restoring the Prepare button (QUIESCE-5)', async () => {
    const { resume } = setQuiesceApi();
    await mountSettings(root);
    await tick();
    (root.querySelector('#quiesce-btn') as HTMLButtonElement).click();
    await tick();
    (root.querySelector('#resume-btn') as HTMLButtonElement).click();
    await tick();
    expect(resume).toHaveBeenCalled();
    expect((root.querySelector('#quiesce-btn') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(true);
  });

  it('reflects an already-safe drain on mount: "Safe to shut down" (QUIESCE-3)', async () => {
    setQuiesceApi({ quiesceStatus: vi.fn(async () => ({ quiescing: true, remaining: 0, safe: true, detail: 'Safe to shut down — all work finished.' })) as KbApi['quiesceStatus'] });
    await mountSettings(root);
    await tick();
    expect(root.querySelector('#quiesce-status')!.textContent).toMatch(/Safe to shut down/i);
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(false);
  });
});
