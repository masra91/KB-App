// SPEC-0045 QUIESCE-6 — the optional tray affordance. A single "Prepare for shutdown" / "Resume" item
// that slots into DEV-7's `getExtraTrayItems` hook (between the capture actions and Quit). The item
// toggles on the synchronous `isActiveQuiescing()` — the tray rebuilds on menu-open, so it always reflects
// the current state. The live drain count is shown by the QCAP-14 status readout already at the top of the
// tray; this is just the action toggle. Electron-free at runtime (type-only import) so it unit-tests in node.
import type { MenuItemConstructorOptions } from 'electron';

export interface QuiesceTrayHandlers {
  /** Enter QUIESCING — pause new work + drain (calls the main-process `quiesceActive`). */
  onPrepare: () => void;
  /** Leave QUIESCING — resume normal running (calls `resumeActive`). */
  onResume: () => void;
}

/**
 * Build the QUIESCE-6 tray item(s) for the current state: "Prepare for shutdown…" when running normally,
 * "Resume — cancel shutdown" while quiescing. Returns a one-item array (the hook splices it in behind its
 * own separator).
 */
export function quiesceTrayItems(quiescing: boolean, handlers: QuiesceTrayHandlers): MenuItemConstructorOptions[] {
  return quiescing
    ? [{ label: 'Resume — cancel shutdown', click: () => handlers.onResume() }]
    : [{ label: 'Prepare for shutdown…', click: () => handlers.onPrepare() }];
}
