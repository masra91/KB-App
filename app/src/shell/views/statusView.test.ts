// @vitest-environment happy-dom
//
// SPEC-0030 OBS-5/6/7/9/11/15 — the Pipeline Status view (component tier, TEST-5). The IPC is
// mocked (`window.kbApi.pipelineStatusView`); we assert the rendered DOM (overall state incl. the
// stall banner, per-stage rows, lock, recent-error drill-down, latency) and that it's read-only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mountStatus,
  stopStatusPolling,
  bodyHtml,
  overallHtml,
  stagesHtml,
  lockHtml,
  errorsHtml,
  latencyHtml,
  setAsideHtml,
} from './statusView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { PipelineStatusView, KbApi } from '../../kb/types';

const PERF: PipelineStatusView['perf'] = {
  version: 1, builtAt: 'T', source: null, spanCount: 4, truncated: false,
  copilot: { count: 4, avgMs: 250, p50Ms: 200, p95Ms: 400 },
  stages: [{ stage: 'decompose', runs: 2, avgMs: 1500, throughputPerMin: 30 }],
  whereTimeGoes: { totalMs: 3000, copilotMs: 1000, otherMs: 2000, copilotPct: 0.33 },
  slowest: [{ spanId: 's1', op: 'copilot.invoke', stage: 'claims', itemId: 'E9', durationMs: 87000, startTs: 'T' }],
};

const STALLED: PipelineStatusView = {
  overall: 'stalled',
  stalled: true,
  lastActivity: '2026-06-02T00:00:00.000Z',
  stages: [
    { stage: 'archive', state: 'idle', queueDepth: 0, setAside: 0 },
    { stage: 'decompose', state: 'blocked', queueDepth: 2, setAside: 1 },
    { stage: 'connect', state: 'error', queueDepth: 1, setAside: 0, currentItem: 'person|Ada' },
    { stage: 'claims', state: 'idle', queueDepth: 0, setAside: 0 },
  ],
  lock: { held: true, waiters: 1, holder: 'connect', since: '2026-06-02T00:01:00.000Z' },
  recentErrors: [
    { ts: '2026-06-02T00:02:00.000Z', level: 'error', event: 'decompose.failed', stage: 'decompose', itemId: 'SRC3', runId: 'R1', message: 'copilot exploded' },
  ],
  worktrees: [{ path: '.kb/cache/worktrees/staging', branch: 'staging' }],
  perf: PERF,
  setAsideItems: [{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }],
  builtAt: '2026-06-02T00:03:00.000Z',
};

function setApi(fn: KbApi['pipelineStatusView'], control?: KbApi['pipelineControl']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'pipelineStatusView' | 'pipelineControl'> }).kbApi = {
    pipelineStatusView: fn,
    pipelineControl: control ?? (vi.fn().mockResolvedValue({ ok: true }) as unknown as KbApi['pipelineControl']),
  };
}

describe('statusView render helpers (OBS-5/6/7/11/15)', () => {
  it('overallHtml flags a stall prominently (OBS-11)', () => {
    const h = overallHtml(STALLED);
    expect(h).toContain('Stalled');
    expect(h).toContain('status-stall-note'); // the loud "stuck" banner
    expect(h).toContain('2026-06-02T00:00:00.000Z'); // since last activity
  });

  it('stagesHtml shows state + queue + current item + set-aside (OBS-5/6)', () => {
    const h = stagesHtml(STALLED.stages);
    expect(h).toContain('status-stage-error'); // connect is error
    expect(h).toContain('queue 2'); // decompose queue depth
    expect(h).toContain('▶ person|Ada'); // connect current item
    expect(h).toContain('1 set aside'); // decompose set-aside
  });

  it('lockHtml shows the holder + waiters (OBS-7)', () => {
    expect(lockHtml(STALLED.lock)).toContain('held by <strong>connect</strong>');
    expect(lockHtml(STALLED.lock)).toContain('1 waiting');
    expect(lockHtml({ held: false, waiters: 0 })).toContain('free');
  });

  it('errorsHtml drills down to the cause when expanded (OBS-6)', () => {
    const collapsed = errorsHtml(STALLED.recentErrors, new Set());
    expect(collapsed).toContain('decompose.failed');
    expect(collapsed).not.toContain('copilot exploded'); // hidden until expanded
    const open = errorsHtml(STALLED.recentErrors, new Set([0]));
    expect(open).toContain('copilot exploded'); // the dev-log cause
    expect(open).toContain('runId R1'); // OBS-3 cross-link
  });

  it('latencyHtml surfaces Copilot p50/p95 + where-time-goes (OBS-15)', () => {
    const h = latencyHtml(STALLED);
    expect(h).toContain('p50 200ms');
    expect(h).toContain('p95 400ms');
    expect(h).toContain('33% Copilot');
    expect(h).toContain('decompose: 30/min');
    expect(h).toContain('Slowest ops:'); // OBS-15 recent slow operations
    expect(h).toContain('87000ms');
  });

  it('setAsideHtml lists poison items with stage · name + reason, name preferred over id (OBS-17)', () => {
    const h = setAsideHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }]);
    expect(h).toContain('Set aside — needs attention (1)');
    expect(h).toContain('claims · Ada Lovelace'); // the friendly name is the visible label
    expect(h).toContain('set aside after 3 failed attempts');
  });

  it('setAsideHtml falls back to the item id when no name is known', () => {
    const h = setAsideHtml([{ stage: 'claims', itemId: '01NONAME' }]);
    expect(h).toContain('claims · 01NONAME');
  });

  it('setAsideHtml renders retry/dismiss buttons carrying the stage + id (OBS-17 actions)', () => {
    const h = setAsideHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace' }]);
    expect(h).toContain('data-act="setaside-retry"');
    expect(h).toContain('data-act="setaside-dismiss"');
    expect(h).toContain('data-stage="claims"');
    expect(h).toContain('data-id="01ADAID"');
  });

  it('setAsideHtml disables the buttons + shows the outcome banner while/after acting', () => {
    const h = setAsideHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace' }], { acting: true, actionMsg: 'Retrying Ada Lovelace.' });
    expect(h).toContain('disabled');
    expect(h).toContain('Retrying Ada Lovelace.');
  });

  it('setAsideHtml is empty when nothing is set aside (clean → no panel)', () => {
    expect(setAsideHtml([])).toBe('');
  });

  it('setAsideHtml escapes interpolated values (XSS-safe)', () => {
    const h = setAsideHtml([{ stage: 'claims', itemId: 'x', name: '<img src=x onerror=alert(1)>', reason: '<b>x</b>' }]);
    expect(h).not.toContain('<img src=x');
    expect(h).not.toContain('<b>x</b>');
    expect(h).toContain('&lt;img');
  });

  it('bodyHtml includes the set-aside panel for the STALLED fixture (OBS-17)', () => {
    const h = bodyHtml({ view: STALLED, loading: false, errorMsg: '', expanded: new Set() });
    expect(h).toContain('Set aside — needs attention');
    expect(h).toContain('claims · Ada Lovelace');
  });

  it('bodyHtml renders empty/loading/no-KB states', () => {
    expect(bodyHtml({ view: null, loading: true, errorMsg: '', expanded: new Set() })).toContain('Loading…');
    expect(bodyHtml({ view: null, loading: false, errorMsg: '', expanded: new Set() })).toContain('No knowledge base open');
    expect(bodyHtml({ view: null, loading: false, errorMsg: 'boom', expanded: new Set() })).toContain('boom');
  });

  it('escapes interpolated values (XSS-safe)', () => {
    const evil: PipelineStatusView = { ...STALLED, recentErrors: [{ ts: 't', level: 'error', event: 'e', message: '<script>alert(1)</script>' }] };
    const h = errorsHtml(evil.recentErrors, new Set([0]));
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('mountStatus (OBS-8/9 — live + read-only)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    stopStatusPolling();
    root.remove();
    vi.restoreAllMocks();
  });

  it('loads via IPC and renders the status; error rows toggle on click (OBS-6)', async () => {
    setApi(vi.fn().mockResolvedValue(STALLED));
    mountStatus(root);
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('.status-badge.status-stalled')).not.toBeNull();
    const head = root.querySelector<HTMLButtonElement>('.status-err-head');
    expect(head).not.toBeNull();
    expect(root.textContent).not.toContain('copilot exploded'); // collapsed

    head!.click();
    expect(root.textContent).toContain('copilot exploded'); // expanded the cause

    // Read-only by default (OBS-9), with OBS-17 as the one sanctioned exception: besides the
    // error-drilldown toggles, the only mutating controls are the per-item set-aside retry/dismiss.
    const acts = [...root.querySelectorAll<HTMLElement>('[data-act]')].map((e) => e.dataset.act);
    expect(new Set(acts)).toEqual(new Set(['toggle-err', 'setaside-retry', 'setaside-dismiss']));
  });

  it('Retry on a set-aside item calls pipelineControl{retry} then re-fetches (OBS-17)', async () => {
    const statusFn = vi.fn().mockResolvedValue(STALLED);
    const control = vi.fn().mockResolvedValue({ ok: true, message: 'Retrying Ada Lovelace.' });
    setApi(statusFn, control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();

    const retry = root.querySelector<HTMLButtonElement>('.status-setaside-retry');
    expect(retry).not.toBeNull();
    retry!.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(control).toHaveBeenCalledWith({ action: 'retry', stage: 'claims', itemId: '01ADAID' });
    expect(statusFn.mock.calls.length).toBeGreaterThanOrEqual(2); // re-fetched after the action
    expect(root.textContent).toContain('Retrying Ada Lovelace.'); // outcome banner
  });

  it('Dismiss confirms first, then calls pipelineControl{dismiss}; cancelling does nothing (OBS-17)', async () => {
    const control = vi.fn().mockResolvedValue({ ok: true, message: 'Dismissed Ada Lovelace.' });
    setApi(vi.fn().mockResolvedValue(STALLED), control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    const dismiss = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>('.status-setaside-dismiss')!;

    // Cancel → no IPC call.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    dismiss().click();
    await Promise.resolve();
    expect(control).not.toHaveBeenCalled();

    // Confirm → fires dismiss.
    confirmSpy.mockReturnValue(true);
    dismiss().click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(control).toHaveBeenCalledWith({ action: 'dismiss', stage: 'claims', itemId: '01ADAID' });
  });

  it('renders the no-KB state when the pipeline is inactive', async () => {
    setApi(vi.fn().mockResolvedValue(null));
    mountStatus(root);
    await Promise.resolve();
    await Promise.resolve();
    expect(root.textContent).toContain('No knowledge base open');
  });
});

describe('mountStatus · #145 hang resilience', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    stopStatusPolling();
    vi.clearAllTimers();
    vi.useRealTimers();
    root.remove();
  });

  it('shows an error instead of an infinite "Loading…" when pipelineStatusView hangs (#145)', async () => {
    setApi(vi.fn(() => new Promise<PipelineStatusView>(() => {}))); // hangs
    mountStatus(root);
    await vi.advanceTimersByTimeAsync(0); // initial paint
    expect(root.textContent).toContain('Loading…');

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.status-error')).not.toBeNull(); // surfaced; the poll auto-retries (no button — read-only)
  });
});
