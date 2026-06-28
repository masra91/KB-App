// View→view navigation primitive (SPEC-0017 SHELL). The nav model (`model.select`) is private to the
// shell module, so a view can't switch views directly. This is the thin, decoupled bridge: a view asks
// to navigate by dispatching a `kb:navigate` CustomEvent; the shell listens once and calls `select`.
// Keeps views ignorant of the shell/model (they just name a target view id), and lets any view deep-link
// to another — e.g. the Field Desk's escalation report → the Reviews queue (no dead affordance).
export const NAVIGATE_EVENT = 'kb:navigate';

/** Detail payload of a `kb:navigate` event — the target view id (one of the SHELL view constants). */
export interface NavigateDetail {
  view: string;
}

/** Ask the shell to switch to `view`. Fire-and-forget — a no-op if no shell is mounted (e.g. tests that
 *  don't mount the shell can still listen for the event to assert the intent). */
export function navigateTo(view: string): void {
  document.dispatchEvent(new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, { detail: { view } }));
}

// --- SPEC-0060 VUX-3: the top bar's per-view contextual filter slot ---
// The v3 top bar carries a per-view filter slot (`#topctx`). The shell owns the slot + clears it on every
// view change; a view fills it on activation by calling `setTopbarContext(html)` (its own trusted filter
// markup — NOT user data). This is the decoupled seam (mirrors navigateTo): views stay ignorant of the
// shell. Each view rebuilt in v3 populates its own filters; until then the slot renders empty (no chrome).
export const TOPBAR_CONTEXT_EVENT = 'kb:topbar-context';

/** Detail payload of a `kb:topbar-context` event — the view's contextual-filter HTML (trusted, code-supplied). */
export interface TopbarContextDetail {
  html: string;
}

/** Set the top bar's contextual filter slot to `html` (the calling view's own trusted markup). A no-op if
 *  no shell is mounted. The shell clears the slot on each view change, so a view re-sets it on activation. */
export function setTopbarContext(html: string): void {
  document.dispatchEvent(new CustomEvent<TopbarContextDetail>(TOPBAR_CONTEXT_EVENT, { detail: { html } }));
}
