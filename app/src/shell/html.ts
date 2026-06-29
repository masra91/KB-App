// Tiny DOM/string helpers shared by the renderer and shell views.

/**
 * Escape a string for safe interpolation into innerHTML. NULL-SAFE (ENG-16): a renderer formats
 * pipeline-/agent-produced data whose optional/derived fields can be null/undefined on legacy or
 * partial records (e.g. a Review candidate with `title: null`, raised before title-persistence). A
 * raw `.replace` on such a value threw inside a `.map` and blanked an ENTIRE list ("Loading…
 * forever") — so every shared format helper must tolerate null/undefined (→ '') and coerce any
 * non-string (→ String) rather than throw. Callers may still prefer a meaningful fallback upstream.
 */
export function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Last path segment of a folder path, with a friendly fallback. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'My Library';
}

/**
 * Branded empty-state (#406 / SPEC-0057) — the ONE "nothing here yet" block every view composes instead
 * of ad-hoc `.muted` lines, rendering the `.viz-empty` primitive. Empty is a CALM idle state and this is
 * for empty BY DESIGN only — a load FAILURE must use `renderLoadError` / "Recheck" (#160), never this, so
 * the user never reads "nothing here" when data actually failed to load.
 *
 * `title`/`body`/`glyph` are escaped (null-safe, ENG-16). `glyph` is decorative (aria-hidden); omit it for
 * the default crystalline mark, or pass `null`/'' for none. `action` is caller-built TRUSTED html (e.g. a
 * `.viz-btn`) — keep it to a known primitive, never interpolate user data into it.
 *
 * `compact` (#406, DL-1 ruling) toggles `.viz-empty--compact` — a quiet left-aligned in-section note (a
 * feed/folder list empty sitting directly above its own add-UI), NOT a centered hero: no big padding, no
 * crystalline mark by default, Inter (not Spectral) title. Same calm-idle palette + honesty contract.
 */
export function emptyState(opts: {
  title: string;
  body?: string | null;
  glyph?: string | null;
  action?: string;
  compact?: boolean;
}): string {
  const g = opts.glyph === undefined ? (opts.compact ? '' : '◇') : opts.glyph; // hero defaults to the mark; compact drops it
  const glyph = g ? `<div class="viz-empty__mark" aria-hidden="true">${esc(g)}</div>` : '';
  const body = opts.body ? `<p class="viz-empty__body">${esc(opts.body)}</p>` : '';
  const action = opts.action ? `<div class="viz-empty__action">${opts.action}</div>` : '';
  const cls = opts.compact ? 'viz-empty viz-empty--compact' : 'viz-empty';
  const titleCls = opts.compact ? 'viz-empty__title' : 'viz-empty__title viz-voice'; // compact = Inter, not Spectral hero
  return `<div class="${cls}">${glyph}<p class="${titleCls}">${esc(opts.title)}</p>${body}${action}</div>`;
}
