// Pure view-model for the SPEC-0032 Pipeline Visualization ("The Line"). DOM-free + side-effect-free
// (SHELL-6 / TEST-5): given the backend data (PipelineStatusView + the §9 inFlight/conversion fields,
// locked with DEV-3), derive everything the renderer draws — station states, carriage steppers, and
// the directional funnel deltas — so the maths is node-tested without a DOM or animation.
//
// NB the §9 fields (`inFlight`, `conversion`) + the shared `STAGE_ORDER` constant land via DEV-3's
// backend PR. Until then this module defines the canonical order locally and the renderer mocks the
// data; on rebase, `STAGE_ORDER`/`StageId` swap to `import … from '../../kb/pipelineStages'` (same
// values, locked) with no shape change here.

/** The six stations on the Line, left→right (the locked contract order). `capture`/`promote` are the
 *  endpoints (gate in/out); in-flight items sit at archive/decompose/connect/claims. */
export const STAGE_ORDER = ['capture', 'archive', 'decompose', 'connect', 'claims', 'promote'] as const;
export type StageId = (typeof STAGE_ORDER)[number];

/** Cumulative funnel counts (raw, from the backend); the renderer computes the between-point deltas. */
export interface Conversion {
  captured: number;
  candidates: number;
  entities: number;
  claims: number;
  promoted: number;
}

/** One live source on the Line (a "carriage"). `active` = its stage is *currently draining* it (vs
 *  queued behind) — only the active carriage ember-breathes (VIZ-6). */
export interface InFlightItem {
  itemId: string;
  name: string;
  stage: StageId;
  sinceTs: string;
  active?: boolean;
}

export type CellState = 'done' | 'current' | 'pending';

/**
 * The six-cell stepper for a carriage at `stage` (VIZ-2): stations before the current one are `done`,
 * the current is `current`, later ones `pending`. An unknown stage (defensive) → all pending.
 */
export function stepperCells(stage: StageId): CellState[] {
  const idx = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER.map((_s, i) => {
    if (idx < 0) return 'pending';
    if (i < idx) return 'done';
    if (i === idx) return 'current';
    return 'pending';
  });
}

export type FunnelDirection = 'reduce' | 'expand' | 'flat';

/** One transition between adjacent funnel points, with its directional caption (VIZ-3). */
export interface FunnelSegment {
  from: keyof Conversion;
  to: keyof Conversion;
  fromCount: number;
  toCount: number;
  direction: FunnelDirection;
  /** Human caption: `−N deduped` at a reduction, `+N (×R)` at a fan-out, `→` when flat. */
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
    if (delta < 0) {
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
