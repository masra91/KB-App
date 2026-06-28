// Theme toggle (SPEC-0058 / SPEC-0057 dark "night-study") — the user-reachable Light/Dark switch.
//
// Dark mode SHIPPED as an opt-in token layer (#445: `:root[data-theme="dark"]` re-points the --viz-*
// roles) but was never user-reachable — this is the control that flips it. Discipline (DL-2's themeCohesion
// invariant, SPEC-0057): we ONLY set an explicit `data-theme` on the root (light|dark); we NEVER add a
// `prefers-color-scheme` rule or touch the bare `:root` default — so the fixed-light default stays intact
// and the OS-auto behavior (#214) stays removed. The `auto`/System layer is a SEPARATE foundation (DL-1):
// it scopes `prefers-color-scheme` strictly under `[data-theme="auto"]`; this module is Light/Dark v1 only.
//
// Persistence: localStorage (renderer-local, survives launches), applied on boot BEFORE the shell paints so
// there's no light→dark flash. A bad/absent stored value falls back to the default LIGHT identity.

/** The user-selectable themes in v1 (System/`auto` is DL-1's separate foundation layer). */
export type Theme = 'light' | 'dark';

/** localStorage key for the persisted choice. */
export const THEME_STORAGE_KEY = 'vellum.theme';

/** The default Vellum identity when nothing is stored (brand §3: "the cream study is the product"). */
export const DEFAULT_THEME: Theme = 'light';

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark';
}

/** The persisted theme, or the default LIGHT identity when absent/garbled/unavailable. */
export function readStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // private-mode / disabled storage → default, never throw
  }
}

/** Persist the choice (best-effort — a storage failure must never break the toggle). */
function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the in-session theme still applies, just won't persist */
  }
}

/**
 * Apply a theme to the document root by setting an EXPLICIT `data-theme` — `dark` activates the #445 dark
 * token layer; `light` is the bare default (the attribute is harmless on light since no `[data-theme=light]`
 * override exists, and being explicit keeps the segmented control's selected state unambiguous). Never adds
 * a media query / touches `prefers-color-scheme` (DL-2's themeCohesion invariant). Pure DOM — no persistence.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme);
}

/** Set + persist the chosen theme (the toggle's click handler calls this). */
export function setTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  applyTheme(theme, root);
  storeTheme(theme);
}

/** Apply the persisted (or default) theme on boot — call BEFORE the shell paints to avoid a flash. */
export function initTheme(root: HTMLElement = document.documentElement): Theme {
  const theme = readStoredTheme();
  applyTheme(theme, root);
  return theme;
}
