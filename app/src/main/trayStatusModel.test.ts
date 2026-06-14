// QCAP-14 — the read-only tray live-status readout model (pure, node tier). Asserts the state-gated
// line grammar + the single-vocabulary guard (it composes The Line's OVERALL_GLYPH/OVERALL_LABEL +
// stageDisplayName verbatim, so the menubar can't drift from the Status headline).
import { describe, it, expect } from 'vitest';
import { trayStatusModel, approxCount, MAX_TRAY_STAGES } from './trayStatusModel';
import { OVERALL_GLYPH, OVERALL_LABEL } from '../kb/pipelineStatusLabels';
import type { PipelineStatusView, OverallState } from '../kb/pipelineStatusView';
import type { StageId } from '../kb/pipelineStages';

/** Minimal valid view — trayStatusModel only reads `overall` + `stages`; the rest is cast away. */
function mkView(overall: OverallState, queues: Array<{ stage: StageId; queueDepth: number }>): PipelineStatusView {
  return {
    overall,
    stalled: overall === 'stalled',
    stages: queues.map((q) => ({ stage: q.stage, state: 'idle' as const, queueDepth: q.queueDepth, setAside: 0 })),
  } as unknown as PipelineStatusView;
}

describe('trayStatusModel (QCAP-14 — read-only tray live-status)', () => {
  it('running with a backlog → headline (~rounded waiting) + per-stage (exact, pipeline order)', () => {
    const lines = trayStatusModel(
      mkView('running', [
        { stage: 'decompose', queueDepth: 12 },
        { stage: 'connect', queueDepth: 340 },
        { stage: 'claims', queueDepth: 648 },
      ]),
    );
    // headline: total 1000 → rounded + `~` + the ruled noun "waiting"; per-stage counts stay exact.
    expect(lines).toEqual([
      '◐ Running — ~1,000 waiting',
      'Decompose 12 · Connect 340 · Claim extraction 648', // canonical stageDisplayName (single-vocabulary)
    ]);
  });

  it('idle → one calm line, no per-stage zeros', () => {
    expect(trayStatusModel(mkView('idle', []))).toEqual(['○ Idle — all caught up']);
  });

  it('stalled → one line that surfaces the failure (never hidden behind a friendly word)', () => {
    expect(trayStatusModel(mkView('stalled', [{ stage: 'connect', queueDepth: 3 }]))).toEqual(['✕ Stalled — needs you']);
  });

  it('running but nothing queued → just the state line (no ~0-waiting noise)', () => {
    expect(trayStatusModel(mkView('running', [{ stage: 'connect', queueDepth: 0 }]))).toEqual(['◐ Running']);
  });

  it('more than the top-N busiest stages → top-N by count in pipeline order + an overflow …', () => {
    const lines = trayStatusModel(
      mkView('running', [
        { stage: 'decompose', queueDepth: 12 },
        { stage: 'connect', queueDepth: 340 },
        { stage: 'claims', queueDepth: 648 },
        { stage: 'promote', queueDepth: 5 }, // smallest → dropped from the top-3, collapses to …
      ]),
    );
    expect(lines[1]).toBe('Decompose 12 · Connect 340 · Claim extraction 648 · …');
    expect(MAX_TRAY_STAGES).toBe(3);
  });

  it('no active status (null view) → no readout section', () => {
    expect(trayStatusModel(null)).toEqual([]);
  });

  it('is read-only vocabulary-shared with The Line: headline composes OVERALL_GLYPH + OVERALL_LABEL', () => {
    for (const overall of ['idle', 'running', 'stalled'] as OverallState[]) {
      const head = trayStatusModel(mkView(overall, []))[0] ?? '';
      expect(head.startsWith(`${OVERALL_GLYPH[overall]} ${OVERALL_LABEL[overall]}`)).toBe(true);
    }
  });
});

describe('approxCount — calm, approximate headline magnitude (per-stage stays exact)', () => {
  it('is exact below 10 (small counts read precisely)', () => {
    expect(approxCount(0)).toBe(0);
    expect(approxCount(5)).toBe(5);
    expect(approxCount(9)).toBe(9);
  });
  it('rounds to 2 significant figures so the headline does not twitch per item', () => {
    expect(approxCount(12)).toBe(12);
    expect(approxCount(340)).toBe(340);
    expect(approxCount(648)).toBe(650);
    expect(approxCount(1116)).toBe(1100);
    expect(approxCount(1000)).toBe(1000);
  });
});
