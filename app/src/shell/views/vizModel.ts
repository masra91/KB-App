// Pure view-model for the SPEC-0032 Pipeline Visualization ("The Line"). DOM-free + side-effect-free
// (SHELL-6 / TEST-5): given the backend data (PipelineStatusView + the §9 inFlight/conversion fields,
// locked with DEV-3), derive everything the renderer draws — station states, carriage steppers, and
// the directional funnel deltas — so the maths is node-tested without a DOM or animation.
//
// The canonical stage order is the shared `kb/pipelineStages` constant (DEV-3's #168) — one source of
// truth both the backend view-model and this frontend import, so they can't drift. Re-exported here so
// the renderer + tests keep importing stage types from the view-model.
import { STAGE_ORDER, stageIndex, type StageId } from '../../kb/pipelineStages';
export { STAGE_ORDER, type StageId } from '../../kb/pipelineStages';

// The §9 data shapes are the backend's source of truth (DEV-3's #169/#175) — import + re-export them
// so the renderer + tests bind to the exact `PipelineStatusView` fields, no parallel mirror to drift.
import type { ConversionCounts, InFlightItem } from '../../kb/pipelineStatusView';
export type { InFlightItem } from '../../kb/pipelineStatusView';

/** Cumulative funnel counts (raw cumulative tallies from the backend); the renderer computes the
 *  between-point deltas + the terminal completion ratio. Alias of the backend `ConversionCounts`. */
export type Conversion = ConversionCounts;

export type CellState = 'done' | 'current' | 'pending';

/**
 * The six-cell stepper for a carriage at `stage` (VIZ-2): stations before the current one are `done`,
 * the current is `current`, later ones `pending`. An unknown stage (defensive) → all pending.
 */
export function stepperCells(stage: StageId): CellState[] {
  const idx = stageIndex(stage); // shared kb/pipelineStages helper (−1 if unknown)
  return STAGE_ORDER.map((_s, i) => {
    if (idx < 0) return 'pending';
    if (i < idx) return 'done';
    if (i === idx) return 'current';
    return 'pending';
  });
}

export type FunnelDirection = 'reduce' | 'expand' | 'flat' | 'complete';

/** One transition between adjacent funnel points, with its directional caption (VIZ-3). */
export interface FunnelSegment {
  from: keyof Conversion;
  to: keyof Conversion;
  fromCount: number;
  toCount: number;
  direction: FunnelDirection;
  /** Human caption: `−N deduped` (reduction), `+N (×R)` (fan-out), `→` (flat), or — for the terminal
   *  →promoted segment — the completion ratio `promoted/captured · P%` (Design-Lead #171). */
  caption: string;
}

const FUNNEL_POINTS: (keyof Conversion)[] = ['captured', 'candidates', 'entities', 'claims', 'promoted'];

/**
 * The funnel as directional segments (VIZ-3, §2): the Line is **not monotonic** — a *reduction*
 * (dedup, e.g. candidates→entities) reads `−N deduped`; a *fan-out* (e.g. entities→claims, where
 * entities expand into many claims) reads `+N (×ratio)`, never a confusing negative where volume
 * grows. Equal counts read `→`. Pure: callers render the captions; this owns the maths (KB-PM
 * guardrail — display only, no backend mutation).
 */
export function funnelSegments(c: Conversion): FunnelSegment[] {
  const segs: FunnelSegment[] = [];
  for (let i = 0; i < FUNNEL_POINTS.length - 1; i++) {
    const from = FUNNEL_POINTS[i];
    const to = FUNNEL_POINTS[i + 1];
    const fromCount = c[from];
    const toCount = c[to];
    const delta = toCount - fromCount;
    let direction: FunnelDirection;
    let caption: string;
    if (to === 'promoted') {
      // Terminal segment is the COMPLETION RATIO, not a delta (Design-Lead #171): `promoted` is
      // sources-on-main (same unit as `captured`), so claims→promoted would be a cross-unit compare.
      direction = 'complete';
      const pct = c.captured > 0 ? Math.round((c.promoted / c.captured) * 100) : 0;
      caption = `${c.promoted}/${c.captured} · ${pct}%`;
    } else if (delta < 0) {
      direction = 'reduce';
      caption = `−${-delta} deduped`;
    } else if (delta > 0) {
      direction = 'expand';
      // ×ratio only when there's a prior volume to expand from (avoid ×∞ / ÷0).
      const ratio = fromCount > 0 ? toCount / fromCount : 0;
      caption = ratio > 0 ? `+${delta} (×${ratio.toFixed(1)})` : `+${delta}`;
    } else {
      direction = 'flat';
      caption = '→';
    }
    segs.push({ from, to, fromCount, toCount, direction, caption });
  }
  return segs;
}

/** Aggregate carriages beyond the visible cap into a "+K more" row (VIZ-9 virtualization, N=12). */
export const MAX_VISIBLE_CARRIAGES = 12;

export interface CarriageSplit {
  visible: InFlightItem[];
  overflow: number; // 0 when all fit
}

export function splitCarriages(items: InFlightItem[], cap: number = MAX_VISIBLE_CARRIAGES): CarriageSplit {
  if (items.length <= cap) return { visible: items, overflow: 0 };
  return { visible: items.slice(0, cap), overflow: items.length - cap };
}
