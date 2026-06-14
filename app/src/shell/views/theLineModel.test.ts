// "The Line" pure presentation model (SPEC-0032 / DESIGN-VIZ). DOM-free — the funnel unit logic (§2),
// the stepper fill (VIZ-2), dwell, the slowest-station pick (VIZ-4), and the >12 virtualization
// (VIZ-9) are the parts most worth pinning, so they're tested here without a DOM.
import { describe, it, expect } from 'vitest';
import {
  bucketFor,
  directionalDelta,
  completionRatio,
  buildFunnel,
  buildStations,
  pendingBarGeometry,
  slowestStage,
  stepperCells,
  dwellLabel,
  MAX_PLAUSIBLE_DWELL_MS,
  splitCarriages,
  STATION_GLYPH,
  OVERALL_GLYPH,
  MAX_CARRIAGES,
} from './theLineModel';
import type { PipelineStatusView, ConversionCounts, InFlightItem } from '../../kb/pipelineStatusView';

const CONV: ConversionCounts = { captured: 10, candidates: 30, entities: 7, claims: 22, promoted: 5 };

const PERF: PipelineStatusView['perf'] = {
  version: 1, builtAt: 'T', source: null, spanCount: 4, truncated: false,
  copilot: { count: 4, avgMs: 250, p50Ms: 200, p95Ms: 400 },
  stages: [
    { stage: 'decompose', runs: 2, avgMs: 1500, throughputPerMin: 30 },
    { stage: 'claims', runs: 3, avgMs: 8200, throughputPerMin: 12 },
  ],
  whereTimeGoes: { totalMs: 3000, copilotMs: 1000, otherMs: 2000, copilotPct: 0.33 },
  slowest: [],
};

function viewWith(over: Partial<PipelineStatusView> = {}): PipelineStatusView {
  return {
    overall: 'running', stalled: false,
    stages: [
      { stage: 'archive', state: 'idle', queueDepth: 0, setAside: 0 },
      { stage: 'decompose', state: 'running', queueDepth: 2, setAside: 1, currentItem: 'SRC9' },
      { stage: 'connect', state: 'blocked', queueDepth: 1, setAside: 0 },
      { stage: 'claims', state: 'error', queueDepth: 0, setAside: 0 },
    ],
    lock: { held: false, waiters: 0 },
    recentErrors: [], worktrees: [], perf: PERF, setAsideItems: [],
    conversion: CONV, inFlight: [], builtAt: 'T', ...over,
  };
}

describe('theLineModel — funnel unit logic (§2 / VIZ-3)', () => {
  it('bucketFor maps stations to conversion buckets (capture/archive→captured, …, promote→promoted)', () => {
    expect(bucketFor('capture', CONV)).toBe(10);
    expect(bucketFor('archive', CONV)).toBe(10); // archive is a whole-source pass-through
    expect(bucketFor('decompose', CONV)).toBe(30); // candidates
    expect(bucketFor('connect', CONV)).toBe(7); // entities
    expect(bucketFor('claims', CONV)).toBe(22);
    expect(bucketFor('promote', CONV)).toBe(5);
  });

  it('directionalDelta reads a reduction as −N deduped, a fan-out as +N ×ratio fan-out, no change as empty (VIZ-10 role signifiers)', () => {
    expect(directionalDelta(30, 7)).toEqual({ text: '−23 deduped', kind: 'reduction' });
    expect(directionalDelta(7, 22)).toEqual({ text: '+15 ×3.1 fan-out', kind: 'fanout' });
    expect(directionalDelta(10, 10)).toEqual({ text: '', kind: 'none' });
  });

  it('directionalDelta fan-out from a zero base omits the ×ratio (no divide-by-zero) but keeps the fan-out signifier', () => {
    expect(directionalDelta(0, 12)).toEqual({ text: '+12 fan-out', kind: 'fanout' });
  });

  it('completionRatio is promoted/captured · P%, with a 0/0 · 0% cold-start guard', () => {
    expect(completionRatio(5, 10)).toBe('5/10 · 50%');
    expect(completionRatio(0, 0)).toBe('0/0 · 0%'); // captured 0 → guarded
    expect(completionRatio(1, 3)).toBe('1/3 · 33%');
  });

  it('buildFunnel: 6 rails; PROMOTE = completion ratio (complete), CLAIMS = no caption (next crosses units), mid = role-declaring → projections', () => {
    const rails = buildFunnel(CONV);
    expect(rails.map((r) => r.stage)).toEqual(['capture', 'archive', 'decompose', 'connect', 'claims', 'promote']);
    // PROMOTE: terminal ratio gets a `complete` signifier, no leading → (no next stage).
    expect(rails[5]).toMatchObject({ stage: 'promote', caption: '5/10 · 50% complete', captionKind: 'ratio' });
    expect(rails[4]).toMatchObject({ stage: 'claims', caption: '', captionKind: 'none' }); // crosses units
    // mid stages: a leading → ties the projection to the next station so it never reads as a backlog.
    expect(rails[2]).toMatchObject({ stage: 'decompose', caption: '→ −23 deduped', captionKind: 'reduction' }); // candidates(30)→entities(7)
    expect(rails[3]).toMatchObject({ stage: 'connect', caption: '→ +15 ×3.1 fan-out', captionKind: 'fanout' }); // entities(7)→claims(22)
    expect(rails[0].caption).toBe(''); // capture→archive: same unit, no caption
  });

  it('buildFunnel carries each number-role its signifier: volume bucket noun + decode-on-hover titles (VIZ-10)', () => {
    const rails = buildFunnel(CONV);
    // role 1 — volume: every rail names its bucket noun + a title declaring what reached where.
    expect(rails[3]).toMatchObject({ stage: 'connect', noun: 'entities', countTitle: '7 entities reached Connect' });
    expect(rails[1]).toMatchObject({ stage: 'archive', noun: 'captured' }); // archive reads the captured bucket
    expect(rails[5].noun).toBe('promoted');
    // role 2 — projection: the title says it's a projection INTO the next stage, never waiting-here.
    expect(rails[3].captionTitle).toBe('projected fan-out ×3.1 into Claim extraction');
    expect(rails[2].captionTitle).toBe('projected reduction −23 deduped into Connect');
    expect(rails[5].captionTitle).toBe('5 of 10 captured sources promoted to main');
    expect(rails[4].captionTitle).toBe(''); // claims has no projection caption → no title
  });

  it('buildFunnel bars scale to the peak bucket (a fan-out reads as widening, not overflow)', () => {
    const rails = buildFunnel(CONV); // buckets 10/10/30/7/22/5 → peak = candidates 30
    expect(rails[2].barPct).toBe(100); // decompose = candidates = the peak
    expect(rails[4].barPct).toBe(Math.round((22 / 30) * 100)); // claims relative to peak
    expect(rails[3].barPct).toBe(Math.round((7 / 30) * 100)); // entities relative to peak
    expect(buildFunnel({ captured: 0, candidates: 0, entities: 0, claims: 0, promoted: 0 }).every((r) => r.barPct === 0)).toBe(true);
  });
});

describe('theLineModel — stations (§6, state never colour alone)', () => {
  it('buildStations renders all six STAGE_ORDER stations even when the view-model enumerates fewer', () => {
    const st = buildStations(viewWith());
    expect(st.map((s) => s.stage)).toEqual(['capture', 'archive', 'decompose', 'connect', 'claims', 'promote']);
    // capture + promote aren't in the view-model `stages` → default to idle/empty, not dropped.
    expect(st[0]).toMatchObject({ stage: 'capture', state: 'idle', queueDepth: 0 });
    expect(st[5]).toMatchObject({ stage: 'promote', state: 'idle' });
  });

  it('each station carries a distinct glyph + hue class for its state (glyph + colour + fill, §3)', () => {
    const st = buildStations(viewWith());
    const decompose = st.find((s) => s.stage === 'decompose')!;
    const connect = st.find((s) => s.stage === 'connect')!;
    const claims = st.find((s) => s.stage === 'claims')!;
    expect(decompose).toMatchObject({ state: 'running', glyph: STATION_GLYPH.running, stateClass: 'viz-state-running', currentItem: 'SRC9' });
    expect(connect).toMatchObject({ state: 'blocked', glyph: STATION_GLYPH.blocked, stateClass: 'viz-state-blocked' });
    expect(claims).toMatchObject({ state: 'error', glyph: STATION_GLYPH.error, stateClass: 'viz-state-error' });
    // the four glyphs are all different (survives grayscale / colour-blindness)
    expect(new Set(Object.values(STATION_GLYPH)).size).toBe(4);
    expect(new Set(Object.values(OVERALL_GLYPH)).size).toBe(3);
  });

  it('flags the slowest station (max mean duration) and captions its latency (§6 / VIZ-4)', () => {
    const st = buildStations(viewWith()); // claims avg 8200 > decompose 1500
    expect(st.find((s) => s.stage === 'claims')!.slowest).toBe(true);
    expect(st.find((s) => s.stage === 'claims')!.latency).toBe('8200ms avg');
    expect(st.find((s) => s.stage === 'decompose')!.slowest).toBe(false);
  });

  it('flags the queue concerning only when the backlog is STUCK (blocked/error), never on depth alone — the cry-wolf guard (§6 role 3 / VIZ-10)', () => {
    const st = buildStations(
      viewWith({
        overall: 'running',
        stalled: false,
        stages: [
          { stage: 'decompose', state: 'running', queueDepth: 250, setAside: 0 }, // deep but DRAINING → calm
          { stage: 'connect', state: 'blocked', queueDepth: 1, setAside: 0 }, // stuck w/ backlog → brass
          { stage: 'claims', state: 'error', queueDepth: 3, setAside: 0 }, // errored w/ backlog → brass
        ],
      }),
    );
    expect(st.find((s) => s.stage === 'decompose')!.queueConcerning).toBe(false); // depth alone ≠ concern
    expect(st.find((s) => s.stage === 'connect')!.queueConcerning).toBe(true);
    expect(st.find((s) => s.stage === 'claims')!.queueConcerning).toBe(true);
  });

  it('an overall-stalled pipeline (OBS-11) flags any backlogged station brass; an empty queue never does', () => {
    const st = buildStations(
      viewWith({
        overall: 'stalled',
        stalled: true,
        stages: [
          { stage: 'decompose', state: 'idle', queueDepth: 4, setAside: 0 }, // stalled + backlog → brass
          { stage: 'connect', state: 'idle', queueDepth: 0, setAside: 0 }, // no backlog → calm even when stalled
        ],
      }),
    );
    expect(st.find((s) => s.stage === 'decompose')!.queueConcerning).toBe(true);
    expect(st.find((s) => s.stage === 'connect')!.queueConcerning).toBe(false);
  });

  it('slowestStage returns null when no stage has timing yet (cold start)', () => {
    expect(slowestStage({ ...PERF, stages: [] })).toBeNull();
    expect(slowestStage({ ...PERF, stages: [{ stage: 'archive', runs: 0, avgMs: 0, throughputPerMin: 0 }] })).toBeNull();
  });
});

// VIZ-12 (SPEC-0032, #336 design) — the rail's primary fill is the two-segment PENDING bar: per
// station, queued (waiting) vs in-progress (active), the bar height scaled to the peak pending across
// all six stations (relative backlog). DEV-6 owns the bar fill GEOMETRY (these tests) + the `▣ active`
// count; the data derivation (`pendingForStage`) is pinned in pipelineStatusView.test.ts.
describe('theLineModel — VIZ-12 pending-work bar geometry', () => {
  it('pendingBarGeometry scales the ember (active) base + queued cap to the peak pending across stations', () => {
    expect(pendingBarGeometry(0, 0, 0)).toEqual({ activePct: 0, queuedPct: 0 }); // nothing pending → empty track
    expect(pendingBarGeometry(3, 1, 4)).toEqual({ activePct: 25, queuedPct: 75 }); // 1 active + 3 queued, this IS the peak (4) → fills track
    expect(pendingBarGeometry(2, 2, 8)).toEqual({ activePct: 25, queuedPct: 25 }); // 4 of peak 8 → only half the track (relative backlog)
  });

  it('pendingBarGeometry floors negative/NaN counts to 0 — a malformed roster entry never makes a NaN height (ENG-16)', () => {
    expect(pendingBarGeometry(-5, Number.NaN, 4)).toEqual({ activePct: 0, queuedPct: 0 });
    expect(pendingBarGeometry(2, Number.NaN, 4)).toEqual({ activePct: 0, queuedPct: 50 }); // bad active → 0, queued still scales
  });

  it('buildStations splits the in-flight roster into queued vs in-progress per station + scales the bar to peak pending', () => {
    const inFlight: InFlightItem[] = [
      { itemId: 'd1', name: 'A', stage: 'decompose', active: true, sinceTs: 'T' }, // decompose: 1 active …
      { itemId: 'd2', name: 'B', stage: 'decompose' }, // … + 2 queued = 3 pending (the peak)
      { itemId: 'd3', name: 'C', stage: 'decompose' },
      { itemId: 'c1', name: 'D', stage: 'claims' }, // claims: 1 queued
    ];
    const st = buildStations(viewWith({ inFlight }));
    const decompose = st.find((s) => s.stage === 'decompose')!;
    const claims = st.find((s) => s.stage === 'claims')!;
    expect(decompose).toMatchObject({ queued: 2, inProgress: 1 });
    expect(decompose.pendingBar).toEqual({ activePct: (1 / 3) * 100, queuedPct: (2 / 3) * 100 }); // peak station fills the track
    expect(claims).toMatchObject({ queued: 1, inProgress: 0 });
    expect(claims.pendingBar).toEqual({ activePct: 0, queuedPct: (1 / 3) * 100 }); // 1 of peak 3 → a third-height cool cap, no ember
  });

  it('ENG-15/16: an empty/absent roster yields empty bars (no false ember); a legacy item missing `active` falls to queued', () => {
    const empty = buildStations(viewWith({ inFlight: [] }));
    expect(empty.every((s) => s.queued === 0 && s.inProgress === 0)).toBe(true);
    expect(empty.every((s) => s.pendingBar.activePct === 0 && s.pendingBar.queuedPct === 0)).toBe(true);
    // a legacy roster item with no `active` flag counts as queued, never as a (breathing) in-progress → no false ember
    const legacy = buildStations(viewWith({ inFlight: [{ itemId: 'x', name: 'L', stage: 'connect' } as InFlightItem] }));
    const connect = legacy.find((s) => s.stage === 'connect')!;
    expect(connect).toMatchObject({ queued: 1, inProgress: 0 });
    expect(connect.pendingBar.activePct).toBe(0);
  });
});

describe('theLineModel — carriages (VIZ-2 stepper, VIZ-9 virtualization)', () => {
  it('stepperCells fills done < current = lit < pending by stageIndex', () => {
    expect(stepperCells('capture')).toEqual(['current', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(stepperCells('connect')).toEqual(['done', 'done', 'done', 'current', 'pending', 'pending']);
    expect(stepperCells('promote')).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  });

  it('dwellLabel formats the active dwell, and is empty when absent/unparseable', () => {
    const now = Date.parse('2026-06-02T00:00:12.000Z');
    expect(dwellLabel('2026-06-02T00:00:00.000Z', now)).toBe('12s on Copilot');
    expect(dwellLabel(undefined, now)).toBe('');
    expect(dwellLabel('not-a-date', now)).toBe('');
    expect(dwellLabel('2026-06-02T00:00:30.000Z', now)).toBe('0s on Copilot'); // future ts floored at 0
  });

  it('OBS-26: a dwell past the max plausible runtime reads as "stalled?", not an ever-growing number', () => {
    // Regression for the ghost: "caroline linking for 4602s" (~77 min) — a stale/wedged in-progress
    // marker with no live worker. Before: a forever-growing seconds counter that looks like a
    // catastrophic live hang. After: a bounded, questioning "stalled? · Nm".
    const start = '2026-06-02T00:00:00.000Z';
    const startMs = Date.parse(start);
    expect(dwellLabel(start, startMs + 4602_000)).toBe('stalled? · 77m'); // the reported ghost
    expect(dwellLabel(start, startMs + MAX_PLAUSIBLE_DWELL_MS + 1)).toContain('stalled?'); // just past the cap
    expect(dwellLabel(start, startMs + MAX_PLAUSIBLE_DWELL_MS - 1)).toContain('on Copilot'); // just under → live
    expect(dwellLabel(start, startMs + 70 * 60_000)).not.toContain('4200s'); // never the raw growing seconds
  });

  it('splitCarriages builds carriage models, active-first, with the stepper + dwell only on active', () => {
    const now = Date.parse('2026-06-02T00:00:10.000Z');
    const items: InFlightItem[] = [
      { itemId: 'q1', name: 'queued-one', stage: 'archive' }, // queued (no dwell)
      { itemId: 'a1', name: 'active-one', stage: 'decompose', active: true, sinceTs: '2026-06-02T00:00:00.000Z' },
    ];
    const { shown, more } = splitCarriages(items, now);
    expect(more).toBe(0);
    expect(shown[0]).toMatchObject({ itemId: 'a1', active: true, stageName: 'Decompose', dwell: '10s on Copilot' }); // active sorts first
    expect(shown[1]).toMatchObject({ itemId: 'q1', active: false, dwell: '' });
    expect(shown[0].cells).toEqual(stepperCells('decompose'));
  });

  it('surfaces the upstream-resolved name verbatim (the never-a-ULID guard lives in buildInFlightRoster)', () => {
    // splitCarriages trusts InFlightItem.name — it has already been through displayItemName in
    // buildInFlightRoster (PRIN-24), so the carriage layer just renders it (a raw ULID id never
    // reaches here as a name). The id→name resolution + never-a-ULID guard is tested in
    // pipelineStatusView.test.ts (buildInFlightRoster).
    const { shown } = splitCarriages([{ itemId: '01HZESPVN2X1G3QK9M4T7B8C5D', name: 'Quarterly report', stage: 'claims' }], 0);
    expect(shown[0].name).toBe('Quarterly report');
  });

  it('collapses beyond MAX_CARRIAGES into a +K more count, keeping active ones on screen (VIZ-9)', () => {
    const many: InFlightItem[] = Array.from({ length: MAX_CARRIAGES + 3 }, (_, i) => ({ itemId: `i${i}`, name: `n${i}`, stage: 'archive' as const }));
    // make the LAST one active — it must survive into the shown set despite being last in input order
    many[many.length - 1] = { itemId: 'live', name: 'live', stage: 'claims', active: true, sinceTs: '2026-06-02T00:00:00.000Z' };
    const { shown, more } = splitCarriages(many, Date.parse('2026-06-02T00:00:05.000Z'));
    expect(shown).toHaveLength(MAX_CARRIAGES);
    expect(more).toBe(3);
    expect(shown[0].itemId).toBe('live'); // active hoisted into view
  });
});
