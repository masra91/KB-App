// Pure HTML render helpers for the SPEC-0032 Pipeline Visualization ("The Line"). Each returns an
// HTML string from the view-model (vizModel) — DOM-free + node/string-testable (SHELL-6/TEST-5);
// `mountViz` (separate) wires the IPC + animation. `esc()` on every interpolation (XSS-safe).
//
// Classes map to the design's `--viz-*` tokens + state semantics (§3/§6); the stylesheet styles them.
// State is NEVER carried by color alone (DESIGN-4): every state also carries a glyph + a fill class,
// so it survives color-blindness / grayscale / reduced-motion.
import { esc } from '../html';
import {
  STAGE_ORDER,
  stepperCells,
  funnelSegments,
  splitCarriages,
  type StageId,
  type InFlightItem,
  type Conversion,
  type CellState,
} from './vizModel';

/** Glyph per station state (§6) — also the color-blind-safe channel alongside the hue. */
const STATE_GLYPH: Record<string, string> = { running: '◐', blocked: '▣', idle: '○', settled: '✓', error: '✕' };

/** One carriage cell glyph by stepper state (§6: filled=done, ▣ lit=current, · pending). */
const CELL_GLYPH: Record<CellState, string> = { done: '█', current: '▣', pending: '·' };

/**
 * The in-flight carriages (VIZ-2 "pizza tracker"): each live source is a six-cell stepper across the
 * Line; the `active` one gets `viz-breathe` (the single ember pulse, VIZ-6). Beyond the visible cap
 * the rest collapse into a "+K more in flight" row (VIZ-9 virtualization). Returns '' when nothing's
 * in flight (the caller omits the section).
 */
export function carriagesHtml(inFlight: InFlightItem[]): string {
  if (inFlight.length === 0) return '';
  const { visible, overflow } = splitCarriages(inFlight);
  const rows = visible.map(carriageHtml).join('');
  const more = overflow > 0 ? `<li class="viz-carriage-more muted">+${overflow} more in flight</li>` : '';
  return `<ul class="viz-carriages">${rows}${more}</ul>`;
}

function carriageHtml(item: InFlightItem): string {
  const cells = stepperCells(item.stage)
    .map((c) => `<span class="viz-cell viz-cell-${c}" aria-hidden="true">${CELL_GLYPH[c]}</span>`)
    .join('');
  const active = item.active ? ' viz-breathe' : '';
  // The raw stage id rides in data-stage / title (display name on the chip); itemId for the click→trace.
  return `<li class="viz-carriage${active}" data-item="${esc(item.itemId)}" data-stage="${esc(item.stage)}">
    <span class="viz-carriage-name">▸ ${esc(item.name)}</span>
    <span class="viz-stepper" role="img" aria-label="at ${esc(item.stage)}">${cells}</span>
  </li>`;
}

/**
 * The funnel as gauge-rail delta captions (VIZ-3): one directional caption per transition between the
 * five conversion points — `−N deduped` at a reduction, `+N (×R)` at a fan-out (entities→claims),
 * `→` when flat. The maths is the view-model's (`funnelSegments`); this renders the captions with a
 * direction class so the stylesheet can tint reductions vs fan-outs.
 */
export function funnelHtml(conversion: Conversion): string {
  const segs = funnelSegments(conversion);
  const items = segs
    .map(
      (s) =>
        `<li class="viz-delta viz-delta-${s.direction}"><span class="viz-delta-from">${s.fromCount}</span>` +
        `<span class="viz-delta-caption">${esc(s.caption)}</span>` +
        `<span class="viz-delta-to">${s.toCount}</span></li>`,
    )
    .join('');
  return `<ul class="viz-funnel">${items}</ul>`;
}

/** A station node's state class + glyph (§6). `running` is the one that embers + breathes. */
export function stationGlyph(state: string): string {
  return STATE_GLYPH[state] ?? STATE_GLYPH.idle;
}

/** Display-only: the six station labels in Line order (UPPERCASE signage is a CSS `text-transform`). */
export function stationOrder(): readonly StageId[] {
  return STAGE_ORDER;
}
