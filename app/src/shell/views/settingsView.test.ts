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
    getInstanceSettings: vi.fn(async () => ({ autonomyDefault, devLogLevel: 'info' as const })),
    setInstanceSettings: set as KbApi['setInstanceSettings'],
  };
  return { set };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
function changeTo(root: HTMLElement, value: string): void {
  const sel = root.querySelector('#autonomy-default') as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
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
    expect((root.querySelector('#autonomy-default') as HTMLSelectElement).value).toBe('guarded');
  });

  it('→ Autonomous confirms before persisting (PANEL-7)', async () => {
    const { set } = setApi('guarded');
    await mountSettings(root);
    await tick();

    changeTo(root, 'autonomous');
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(false);
    expect(set).not.toHaveBeenCalled();

    (root.querySelector('#autonomy-go') as HTMLButtonElement).click();
    await tick();
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'info' });
    expect(root.querySelector('#autonomy-status')?.textContent).toContain('Autonomous');
  });

  it('cancelling the confirm reverts the select and does not persist', async () => {
    const { set } = setApi('guarded');
    await mountSettings(root);
    await tick();
    changeTo(root, 'autonomous');
    (root.querySelector('#autonomy-cancel') as HTMLButtonElement).click();
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('#autonomy-default') as HTMLSelectElement).value).toBe('guarded');
    expect(set).not.toHaveBeenCalled();
  });

  it('relaxing to Guarded applies directly (no confirm)', async () => {
    const { set } = setApi('autonomous');
    await mountSettings(root);
    await tick();
    changeTo(root, 'guarded');
    await tick();
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(true);
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'guarded', devLogLevel: 'info' });
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
    const sel = root.querySelector('#devlog-level') as HTMLSelectElement;
    expect(sel.value).toBe('info');

    sel.value = 'debug';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    // The whole settings object is sent — autonomyDefault not clobbered (no confirm; benign toggle).
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'debug' });
    expect(root.querySelector('#verbosity-status')?.textContent).toContain('Debug');
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
      getInstanceSettings: vi.fn(async () => ({ autonomyDefault: 'guarded' as const, devLogLevel: 'info' as const })),
      setInstanceSettings: vi.fn(async (s: InstanceSettings) => s) as KbApi['setInstanceSettings'],
    };
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain('My KB');
  });
});
