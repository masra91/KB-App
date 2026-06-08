// Canonical overall-pipeline-state vocabulary (glyph + word) — the SINGLE source so every surface
// that reports overall state reads as the same system and can't drift (DESIGN-VIZ / QCAP-14). The
// Status headline ("The Line", renderer) and the menubar tray readout (main process) both compose
// these, so the vocabulary lives in the neutral `kb` layer (importable by both shell and main, no
// cross-layer dependency). State is glyph + word (never colour-alone, DESIGN-4) — disabled menu items
// and grayscale both survive.
import type { OverallState } from './pipelineStatusView';
import { UNTITLED_SOURCE } from './sourceDoc';

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

// Canonical ULID shape (Crockford base32, 26 chars) — mirrors `isUlid()` in `ulid.ts`, re-stated here
// as a pure regex because `ulid.ts` value-imports `node:crypto` and THIS module is renderer-imported
// (the #248 boundary: a renderer value-import of a node builtin breaks the Vite bundle). Excludes
// I/L/O/U like Crockford's alphabet.
const ULID_RE = /^[0-9A-HJKM-NP-TV-Z]{26}$/i;

/** The human label every surface shows for an in-flight / current pipeline item (PRIN-24): the
 *  resolved `name` — a source's title, derived upstream by `deriveSourceTitle` in the main process
 *  (off the render path, baked into OBS-24's cached snapshot) — never a raw internal id. A source id
 *  that couldn't be resolved (a bare ULID) collapses to the SAME neutral generic `deriveSourceTitle`
 *  uses (`UNTITLED_SOURCE`), so The Line, the Status stations, and the tray can NEVER print a ULID.
 *  A non-ULID id (an entity id, a connect `kind|name` block key) is already human-readable, so it
 *  shows as-is rather than being mislabelled "Untitled source". Pure — no fs, renderer-safe. */
export function displayItemName(name: string | undefined, id: string): string {
  const n = name?.trim();
  if (n) return n;
  return ULID_RE.test(id) ? UNTITLED_SOURCE : id;
}
