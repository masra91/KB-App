// @vitest-environment happy-dom
//
// "The Line" — the Pipeline Status view (SPEC-0032 / DESIGN-VIZ + SPEC-0030 OBS-5/6/7/9/11/15/17),
// component tier (TEST-5). The IPC is mocked (`window.kbApi.pipelineStatusView`); we assert the
// rendered DOM (the headline state badge, the stuck/stall alarm, the station spine + gauge-rails, the
// in-flight carriages, the set-aside siding, the secondary readout), that the OBS-17 Retry/Dismiss
// contract is unchanged, that it stays read-only (+ the new non-mutating pivot), that oxide never
// colours small text (Design-Lead cert), and the #145 hang-resilience.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mountStatus,
  stopStatusPolling,
  lineBodyHtml,
  overallHtml,
  alarmHtml,
  pivotHtml,
  spineHtml,
  carriagesHtml,
  sidingHtml,
  lockHtml,
  errorsHtml,
  latencyHtml,
} from './statusView';
import { buildStations, splitCarriages } from './theLineModel';
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
  conversion: { captured: 10, candidates: 30, entities: 7, claims: 22, promoted: 6 },
  inFlight: [{ itemId: 'SRC9', name: 'SRC9', stage: 'decompose', active: true, sinceTs: '2026-06-02T00:02:30.000Z' }],
  builtAt: '2026-06-02T00:03:00.000Z',
};

const NOW = Date.parse('2026-06-02T00:03:00.000Z');

function body(v: PipelineStatusView | null, extra: Partial<Parameters<typeof lineBodyHtml>[0]> = {}): string {
  return lineBodyHtml({ view: v, loading: false, errorMsg: '', expanded: new Set(), lens: 'stage', ...extra }, NOW);
}

function setApi(fn: KbApi['pipelineStatusView'], control?: KbApi['pipelineControl']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'pipelineStatusView' | 'pipelineControl'> }).kbApi = {
    pipelineStatusView: fn,
    pipelineControl: control ?? (vi.fn().mockResolvedValue({ ok: true }) as unknown as KbApi['pipelineControl']),
  };
}

describe('The Line — headline + alarm (OBS-5/11, VIZ-1)', () => {
  it('overallHtml shows the state badge with its glyph + state class, friendly last-activity (no raw ISO)', () => {
    const h = overallHtml(STALLED);
    expect(h).toContain('line-overall-stalled');
    expect(h).toContain('>✕</span> Stalled'); // OVERALL_GLYPH.stalled glyph + label
    expect(h).not.toContain('2026-06-02T00:00:00.000Z'); // raw ISO replaced by a friendly time (#3)
  });

  it('alarmHtml raises a STUCK write lock as the primary oxide alarm, naming holder + held duration (#163)', () => {
    const stuck: PipelineStatusView = { ...STALLED, lock: { held: true, waiters: 0, holder: 'claims:advance', stuck: true, heldMs: 125000 } };
    const h = alarmHtml(stuck);
    expect(h).toContain('line-alarm-stuck');
    expect(h).toContain('Claim extraction (advance)'); // holderLabel — stage display name + op suffix
    expect(h).toContain('2m 5s'); // heldFor(125000)
    expect(h).toContain('wedged');
  });

  it('alarmHtml raises a generic stall (queued, no progress) — but not when healthy', () => {
    expect(alarmHtml(STALLED)).toContain('line-alarm-stall'); // stalled, not stuck
    expect(alarmHtml(STALLED)).toContain('looks stuck');
    const healthy: PipelineStatusView = { ...STALLED, overall: 'running', stalled: false, lock: { held: false, waiters: 0 } };
    expect(alarmHtml(healthy)).toBe(''); // quiet when nothing's wrong
  });

  it('oxide colours only the alarm glyph (large) — the reason text stays ink (§3 / Design-Lead cert)', () => {
    const stuck: PipelineStatusView = { ...STALLED, lock: { held: true, waiters: 0, holder: 'connect:afterDrain', stuck: true, heldMs: 60000 } };
    const h = alarmHtml(stuck);
    expect(h).toContain('line-alarm-glyph viz-state-error'); // the GLYPH carries oxide
    expect(h).toContain('line-alarm-text viz-body'); // the TEXT is ink/body
    // the oxide state class never lands on the small reason text
    expect(h).not.toContain('line-alarm-text viz-state-error');
  });
});

describe('The Line — station spine + gauge-rails (§2/§6, VIZ-3/4)', () => {
  const spine = (): string => spineHtml(buildStations(STALLED));

  it('renders all six stations with their state glyph + hue (state never colour alone)', () => {
    const h = spine();
    for (const name of ['Capture', 'Archiving', 'Decompose', 'Linking', 'Claim extraction', 'Promote']) expect(h).toContain(name);
    expect(h).toContain('line-station-error'); // connect is error
    expect(h).toContain('line-station-glyph viz-state-error'); // its glyph carries oxide (large element — allowed)
  });

  it('gauge-rail shows the directional conversion captions (−deduped reduction, +×ratio fan-out, completion ratio)', () => {
    const h = spine(); // conversion 10/30/7/22/6
    expect(h).toContain('−23 deduped'); // decompose candidates(30) → connect entities(7)
    expect(h).toContain('+15 (×3.1)'); // connect entities(7) → claims(22)
    expect(h).toContain('6/10 · 60%'); // PROMOTE completion ratio
  });

  it('the conversion captions are tabular numerics, never the oxide state class on small text', () => {
    const h = spine();
    expect(h).toContain('line-rail-caption line-cap-reduction viz-numeric');
    // the slowest-station rail tints oxide via a bar class, not by colouring the caption text
    expect(h).not.toContain('line-rail-caption line-cap-reduction viz-state-error');
  });

  it('a set-aside count under a station uses an oxide-bordered badge (not oxide-coloured text)', () => {
    const h = spine();
    expect(h).toContain('line-station-setaside line-badge-error'); // decompose has 1 set aside
    expect(h).toContain('set aside');
  });
});

describe('The Line — in-flight carriages (VIZ-2/9)', () => {
  it('renders a carriage with its six-cell stepper, lit current step + dwell on the active one', () => {
    const { shown, more } = splitCarriages(STALLED.inFlight, NOW);
    const h = carriagesHtml(shown, more);
    expect(h).toContain('▸ SRC9');
    expect(h).toContain('line-cell-current line-cell-breathe'); // active → the lit step breathes
    expect(h).toContain('30s on Copilot'); // dwell from sinceTs (00:02:30) to NOW (00:03:00)
    expect(h).toContain('In flight (<span class="viz-numeric">1</span>)');
  });

  it('collapses a large roster into a "+K more in flight" row (VIZ-9 virtualization)', () => {
    const many: PipelineStatusView['inFlight'] = Array.from({ length: 15 }, (_, i) => ({ itemId: `i${i}`, name: `n${i}`, stage: 'archive' as const }));
    const { shown, more } = splitCarriages(many, NOW);
    const h = carriagesHtml(shown, more);
    expect(h).toContain('more in flight');
    expect(h).toContain('In flight (<span class="viz-numeric">15</span>)'); // total still honest
  });

  it('shows a calm empty state when nothing is on the line', () => {
    expect(carriagesHtml([], 0)).toContain('Nothing on the line');
  });
});

describe('The Line — set-aside siding (VIZ-7 / OBS-17, contract unchanged)', () => {
  it('lists poison items as stage · name + reason (name preferred over id)', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }]);
    expect(h).toContain('Set aside — needs attention');
    expect(h).toContain('Claim extraction · Ada Lovelace'); // display name (#4) + friendly name
    expect(h).toContain('set aside after 3 failed attempts');
  });

  it('falls back to the item id when no name is known', () => {
    expect(sidingHtml([{ stage: 'claims', itemId: '01NONAME' }])).toContain('Claim extraction · 01NONAME');
  });

  it('keeps the OBS-17 Retry/Dismiss control contract verbatim (data-act / data-stage / data-id)', () => {
    const h = sidingHtml([{ stage: 'connect', itemId: 'block:engine', name: 'Analytical Engine' }]);
    expect(h).toContain('data-act="setaside-retry"');
    expect(h).toContain('data-act="setaside-dismiss"');
    expect(h).toContain('data-stage="connect"'); // raw id intact → action dispatches to the right stage
    expect(h).toContain('data-id="block:engine"');
  });

  it('the reason line stays ink — the siding never colours small text with the oxide state class', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }]);
    expect(h).toContain('line-siding-reason viz-body'); // ink/body reason
    expect(h).not.toContain('viz-state-error'); // oxide rides the badge fill + the siding's CSS border, not the text
  });

  it('disables the buttons + shows the outcome banner while/after acting', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace' }], { acting: true, actionMsg: 'Retrying Ada Lovelace.' });
    expect(h).toContain('disabled');
    expect(h).toContain('Retrying Ada Lovelace.');
  });

  it('is empty when nothing is set aside (clean → no siding)', () => {
    expect(sidingHtml([])).toBe('');
  });

  it('escapes interpolated values (XSS-safe)', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: 'x', name: '<img src=x onerror=alert(1)>', reason: '<b>x</b>' }]);
    expect(h).not.toContain('<img src=x');
    expect(h).not.toContain('<b>x</b>');
    expect(h).toContain('&lt;img');
  });
});

describe('The Line — pivot toggle (VIZ-5) + secondary readout (OBS-6/7/15)', () => {
  it('pivotHtml renders both lenses, marking the active one (non-mutating, data-act=pivot)', () => {
    const h = pivotHtml('stage');
    expect(h).toContain('data-act="pivot"');
    expect(h).toContain('data-lens="stage"');
    expect(h).toContain('data-lens="item"');
    expect(h).toContain('line-pivot-on" data-act="pivot" data-lens="stage" aria-pressed="true"'); // stage active
  });

  it('lineBodyHtml weights the core by lens (default per-stage)', () => {
    expect(body(STALLED, { lens: 'stage' })).toContain('line-core line-lens-stage');
    expect(body(STALLED, { lens: 'item' })).toContain('line-core line-lens-item');
  });

  it('lockHtml surfaces a STUCK lock loudly in the readout, with the held-duration (#163 OBS-7)', () => {
    const h = lockHtml({ held: true, waiters: 1, holder: 'claims:advance', stuck: true, heldMs: 125000 });
    expect(h).toContain('line-lock-stuck');
    expect(h).toContain('2m 5s');
    expect(h).toContain('wedged');
  });

  it('lockHtml shows holder + waiters + held-duration on a normal hold; free when unheld', () => {
    const held = lockHtml({ held: true, waiters: 1, holder: 'connect', since: '2026-06-02T00:01:00.000Z', heldMs: 3000 });
    expect(held).toContain('held by <strong>Linking</strong>'); // display name (#4)
    expect(held).toContain('1 waiting');
    expect(held).toContain('3s');
    expect(held).not.toContain('Stuck');
    expect(lockHtml({ held: false, waiters: 0 })).toContain('free');
  });

  it('errorsHtml drills down to the cause when expanded (OBS-6)', () => {
    const collapsed = errorsHtml(STALLED.recentErrors, new Set());
    expect(collapsed).toContain('decompose.failed');
    expect(collapsed).not.toContain('copilot exploded'); // hidden until expanded
    const open = errorsHtml(STALLED.recentErrors, new Set([0]));
    expect(open).toContain('copilot exploded'); // the dev-log cause
    expect(open).toContain('runId <span class="viz-numeric">R1</span>'); // OBS-3 cross-link
  });

  it('latencyHtml surfaces Copilot p50/p95 + where-time-goes + throughput (OBS-15)', () => {
    const h = latencyHtml(STALLED);
    expect(h).toContain('p50 <span class="viz-numeric">200ms</span>');
    expect(h).toContain('p95 <span class="viz-numeric">400ms</span>');
    expect(h).toContain('33%</span> Copilot');
    expect(h).toContain('Decompose:'); // display name throughput row
    expect(h).toContain('87000ms'); // slowest op
  });

  it('escapes interpolated values in the error drill-down (XSS-safe)', () => {
    const evil: PipelineStatusView = { ...STALLED, recentErrors: [{ ts: 't', level: 'error', event: 'e', message: '<script>alert(1)</script>' }] };
    const h = errorsHtml(evil.recentErrors, new Set([0]));
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('The Line — body states', () => {
  it('renders loading / no-KB / error states', () => {
    expect(lineBodyHtml({ view: null, loading: true, errorMsg: '', expanded: new Set(), lens: 'stage' }, NOW)).toContain('Loading…');
    expect(body(null)).toContain('No knowledge base open');
    expect(lineBodyHtml({ view: null, loading: false, errorMsg: 'boom', expanded: new Set(), lens: 'stage' }, NOW)).toContain('boom');
  });

  it('the full body wraps the Line in a .viz-surface root (so the reduced-motion reset catches it)', () => {
    // mountStatus sets the .viz-surface root; the body itself carries the spine + siding + readout.
    const h = body(STALLED);
    expect(h).toContain('line-spine'); // stations
    expect(h).toContain('line-siding'); // siding
    expect(h).toContain('line-readout'); // OBS depth
  });
});

describe('mountStatus (OBS-8/9 — live + read-only; VIZ-5 pivot)', () => {
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

  it('mounts a .viz-surface root, loads via IPC, renders the Line; error rows toggle on click (OBS-6)', async () => {
    setApi(vi.fn().mockResolvedValue(STALLED));
    mountStatus(root);
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('.viz-surface.the-line')).not.toBeNull(); // reduced-motion root
    expect(root.querySelector('.line-overall-stalled')).not.toBeNull();
    const head = root.querySelector<HTMLButtonElement>('.line-err-head');
    expect(head).not.toBeNull();
    expect(root.textContent).not.toContain('copilot exploded'); // collapsed

    head!.click();
    expect(root.textContent).toContain('copilot exploded'); // expanded the cause
  });

  it('is read-only except the OBS-17 recovery actions + the non-mutating pivot', async () => {
    setApi(vi.fn().mockResolvedValue(STALLED));
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    const acts = [...root.querySelectorAll<HTMLElement>('[data-act]')].map((e) => e.dataset.act);
    // toggle-err (drill-down) + pivot (lens) are non-mutating; only retry/dismiss mutate.
    expect(new Set(acts)).toEqual(new Set(['toggle-err', 'pivot', 'setaside-retry', 'setaside-dismiss']));
  });

  it('the pivot toggle flips the lens (per-stage ↔ per-item) without an IPC call', async () => {
    const statusFn = vi.fn().mockResolvedValue(STALLED);
    setApi(statusFn);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.line-lens-stage')).not.toBeNull(); // default

    const calls = statusFn.mock.calls.length;
    root.querySelector<HTMLButtonElement>('[data-act="pivot"][data-lens="item"]')!.click();
    expect(root.querySelector('.line-lens-item')).not.toBeNull(); // flipped
    expect(statusFn.mock.calls.length).toBe(calls); // pure view change, no re-fetch
  });

  it('Retry on a set-aside item calls pipelineControl{retry} then re-fetches (OBS-17)', async () => {
    const statusFn = vi.fn().mockResolvedValue(STALLED);
    const control = vi.fn().mockResolvedValue({ ok: true, message: 'Retrying Ada Lovelace.' });
    setApi(statusFn, control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();

    const retry = root.querySelector<HTMLButtonElement>('.line-siding-retry');
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
    const dismiss = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>('.line-siding-dismiss')!;

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    dismiss().click();
    await Promise.resolve();
    expect(control).not.toHaveBeenCalled(); // cancelled

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
    expect(root.querySelector('.line-error')).not.toBeNull(); // surfaced; the poll auto-retries (no button — read-only)
  });
});
