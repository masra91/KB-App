// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-4 + #145 — the Sources view, component tier (happy-dom). IPC (`getState`) mocked;
// we assert the vault info renders and that a hung/slow `getState` degrades gracefully (the view's
// content is mostly static placeholders, so it still renders — never an infinite spinner, PANEL-9).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountSources } from './sourcesView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { KbApi } from '../../kb/types';

function setGetState(fn: KbApi['getState']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'getState'> }).kbApi = { getState: fn };
}

describe('Sources view (SPEC-0027 PANEL-4)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the active vault name + path, and the connected-source placeholders', async () => {
    setGetState(vi.fn(async () => ({ activeVaultPath: '/vault/path', vaultConfig: { schemaVersion: 1, id: 'x', name: 'My KB', createdAt: 't' } })));
    await mountSources(root);
    expect(root.textContent).toContain('My KB');
    expect(root.textContent).toContain('/vault/path');
    expect(root.textContent).toContain('Email — coming soon');
    expect(root.textContent).not.toContain('Loading…');
  });

  it('a caught getState failure still renders the view with em-dash vault info (degrades, never errors the shell)', async () => {
    setGetState(vi.fn(async () => { throw new Error('boom'); }));
    await mountSources(root);
    expect(root.textContent).not.toContain('Loading…');
    expect(root.textContent).toContain('Connected sources'); // the static placeholders still render
    expect(root.querySelector('.source-slots')).toBeTruthy();
  });
});

describe('Sources view · #145 load resilience (no infinite spinner on a hung IPC)', () => {
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

  it('times out a hung getState → renders the view with em-dash vault info, never an infinite spinner', async () => {
    setGetState(vi.fn<KbApi['getState']>().mockReturnValueOnce(new Promise(() => {}))); // hangs
    const mounted = mountSources(root);
    expect(root.textContent).toContain('Loading…'); // spinner initially

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    await mounted;
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.textContent).toContain('Connected sources'); // the view rendered (graceful fallback)
  });
});
