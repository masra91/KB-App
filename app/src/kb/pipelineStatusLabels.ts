// Canonical overall-pipeline-state vocabulary (glyph + word) — the SINGLE source so every surface
// that reports overall state reads as the same system and can't drift (DESIGN-VIZ / QCAP-14). The
// Status headline ("The Line", renderer) and the menubar tray readout (main process) both compose
// these, so the vocabulary lives in the neutral `kb` layer (importable by both shell and main, no
// cross-layer dependency). State is glyph + word (never colour-alone, DESIGN-4) — disabled menu items
// and grayscale both survive.
import type { OverallState } from './pipelineStatusView';

/** Overall headline badge glyph (§2 `◐ RUNNING`). A stall reads as the alarm shape; distinct shapes
 *  so the state survives grayscale / colour-blindness. */
export const OVERALL_GLYPH: Record<OverallState, string> = {
  idle: '○',
  running: '◐',
  stalled: '✕',
};

/** Overall state word, matching the Status headline badge (`statusView.overallHtml`). */
export const OVERALL_LABEL: Record<OverallState, string> = {
  idle: 'Idle',
  running: 'Running',
  stalled: 'Stalled',
};
