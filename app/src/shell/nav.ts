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
