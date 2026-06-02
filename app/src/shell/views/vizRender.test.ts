// @vitest-environment happy-dom
// SPEC-0032 VIZ render helpers — pure HTML from the view-model. We assert the structural output
// (stepper fill, active-breathe, virtualization, directional funnel captions) + XSS-safety.
import { describe, it, expect } from 'vitest';
import { carriagesHtml, funnelHtml, stuckLockAlarmHtml, formatHeldMs, stationsHtml } from './vizRender';
import type { InFlightItem, Conversion } from './vizModel';
import type { LockState } from '../../kb/stageLock';
import type { StageStatus } from '../../kb/pipelineStatusView';

const mk = (over: Partial<InFlightItem> & Pick<InFlightItem, 'itemId' | 'stage'>): InFlightItem => ({
  name: over.itemId,
  sinceTs: 't',
  ...over,
});

function frag(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('carriagesHtml (VIZ-2 pizza-tracker)', () => {
  it('renders a stepper per carriage; only the active one breathes', () => {
    const root = frag(carriagesHtml([mk({ itemId: 'a.md', stage: 'connect', active: true }), mk({ itemId: 'b.md', stage: 'archive' })]));
    const cars = root.querySelectorAll('.viz-carriage');
    expect(cars).toHaveLength(2);
    expect(cars[0].classList.contains('viz-breathe')).toBe(true); // active
    expect(cars[1].classList.contains('viz-breathe')).toBe(false);
    // connect = index 3 of 6 → 3 done, 1 current, 2 pending
    expect(root.querySelectorAll('.viz-carriage')[0].querySelectorAll('.viz-cell-done')).toHaveLength(3);
    expect(root.querySelectorAll('.viz-carriage')[0].querySelectorAll('.viz-cell-current')).toHaveLength(1);
    expect(cars[0].getAttribute('data-stage')).toBe('connect'); // raw id preserved for the trace/dispatch
  });

  it('collapses carriages beyond the cap into a "+K more" row (VIZ-9)', () => {
    const many = Array.from({ length: 15 }, (_v, i) => mk({ itemId: `i${i}.md`, stage: 'claims' as const }));
    const root = frag(carriagesHtml(many));
    expect(root.querySelectorAll('.viz-carriage')).toHaveLength(12);
    expect(root.querySelector('.viz-carriage-more')?.textContent).toContain('+3 more');
  });

  it('is empty when nothing is in flight', () => {
    expect(carriagesHtml([])).toBe('');
  });

  it('escapes a hostile carriage name (XSS-safe)', () => {
    const root = frag(carriagesHtml([mk({ itemId: 'x', stage: 'claims', name: '<img src=x onerror=alert(1)>' })]));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.viz-carriage-name')?.textContent).toContain('<img');
  });
});

describe('funnelHtml (VIZ-3 directional deltas)', () => {
  const C: Conversion = { captured: 10, candidates: 10, entities: 7, claims: 22, promoted: 5 };
  it('renders a directional caption per transition (reduce / expand / flat)', () => {
    const root = frag(funnelHtml(C));
    const captions = Array.from(root.querySelectorAll('.viz-delta-caption')).map((e) => e.textContent);
    expect(captions).toContain('−3 deduped'); // candidates→entities reduction
    expect(captions).toContain('+15 (×3.1)'); // entities→claims fan-out
    expect(root.querySelector('.viz-delta-reduce')).toBeTruthy();
    expect(root.querySelector('.viz-delta-expand')).toBeTruthy();
    expect(root.querySelector('.viz-delta-flat')).toBeTruthy(); // captured→candidates
  });
});

describe('stuckLockAlarmHtml + formatHeldMs (§6 — silent stall made loud)', () => {
  it('formats the held duration (tabular)', () => {
    expect(formatHeldMs(45000)).toBe('45s');
    expect(formatHeldMs(90000)).toBe('1m 30s');
    expect(formatHeldMs(0)).toBe('0s');
  });

  it('raises an oxide alarm naming the real holder + elapsed when the lock is stuck', () => {
    const lock: LockState = { held: true, waiters: 1, holder: 'connect:afterDrain', heldMs: 45000, stuck: true };
    const a = frag(stuckLockAlarmHtml(lock)).querySelector('.viz-stuck-alarm')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('role')).toBe('alert'); // surfaced, not silent
    expect(a.textContent).toContain('stuck');
    expect(a.textContent).toContain('connect:afterDrain'); // the real holder label, not "a stage"
    expect(a.textContent).toContain('45s');
  });

  it('stays silent for a healthy held-but-moving lock or idle (only stuck escalates)', () => {
    expect(stuckLockAlarmHtml({ held: true, waiters: 0, holder: 'claims:advance', heldMs: 1200 })).toBe('');
    expect(stuckLockAlarmHtml({ held: false, waiters: 0 })).toBe('');
  });

  it('falls back to "a stage" with no holder label, and escapes a hostile one', () => {
    expect(frag(stuckLockAlarmHtml({ held: true, waiters: 0, stuck: true })).textContent).toContain('a stage');
    const evil = frag(stuckLockAlarmHtml({ held: true, waiters: 0, holder: '<img src=x onerror=alert(1)>', stuck: true }));
    expect(evil.querySelector('img')).toBeNull();
  });
});

describe('stationsHtml (§2 — the Line spine)', () => {
  const stages: StageStatus[] = [
    { stage: 'archive', state: 'idle', queueDepth: 0, setAside: 0 },
    { stage: 'decompose', state: 'running', queueDepth: 3, setAside: 0 },
    { stage: 'connect', state: 'blocked', queueDepth: 1, setAside: 2 },
    { stage: 'claims', state: 'error', queueDepth: 0, setAside: 1 },
  ];

  it('renders all six stations in canonical order (capture…promote), endpoints idle', () => {
    const root = frag(stationsHtml(stages));
    const st = root.querySelectorAll('.viz-station');
    expect(st).toHaveLength(6);
    expect([...st].map((s) => s.getAttribute('data-stage'))).toEqual(['capture', 'archive', 'decompose', 'connect', 'claims', 'promote']);
    expect(root.querySelector('[data-stage="capture"]')!.classList.contains('viz-state-idle')).toBe(true); // endpoint, no drain state
  });

  it('only the running station breathes; each station carries its state hue', () => {
    const root = frag(stationsHtml(stages));
    expect(root.querySelectorAll('.viz-breathe')).toHaveLength(1);
    expect(root.querySelector('[data-stage="decompose"]')!.classList.contains('viz-breathe')).toBe(true);
    expect(root.querySelector('[data-stage="connect"]')!.classList.contains('viz-state-blocked')).toBe(true);
    expect(root.querySelector('[data-stage="claims"]')!.classList.contains('viz-state-error')).toBe(true);
  });

  it('shows queue depth + set-aside count (state never by color alone — glyph present)', () => {
    const root = frag(stationsHtml(stages));
    expect(root.querySelector('[data-stage="decompose"] .viz-station-queue')!.textContent).toBe('3');
    expect(root.querySelector('[data-stage="connect"] .viz-station-aside')!.textContent).toContain('2');
    expect(root.querySelector('[data-stage="decompose"] .viz-station-glyph')!.textContent).toBe('◐'); // running glyph
  });
});
