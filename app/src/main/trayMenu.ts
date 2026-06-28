// QCAP-14: pure composition of the menubar tray context-menu template into ordered sections, so the
// three contributors compose without colliding (PM-locked seam): the READ-ONLY status readout
// (QCAP-14, DEV-7), the capture ACTION items (QCAP-3/9/11, DEV-1), and an APPENDED hook for later
// optional items (QUIESCE-6 "Prepare for shutdown", DEV-2). Kept electron-free at runtime (type-only
// import) so it's unit-testable in node — the electron glue (quickCaptureElectron.setTray) just feeds
// it the live inputs and hands the result to Menu.buildFromTemplate.
import type { MenuItemConstructorOptions } from 'electron';

const separator = (): MenuItemConstructorOptions => ({ type: 'separator' });

/** Compose the tray menu template: `[status readout] · ─ · [capture actions] · ─ · [extra hook] · ─ · Quit`.
 *  Status lines render as **disabled** items (read-only — the observatory invariant, AUDIT-8/OBS-9: the
 *  menubar reports, it never acts beyond the capture/restore actions). Separators only appear between
 *  non-empty sections (no leading/double rules). DEV-1's action items pass through verbatim, in order;
 *  DEV-2's optional items drop into the extra section via the hook. */
export function buildTrayTemplate(opts: {
  /** The QCAP-14 read-only status readout lines (from `trayStatusModel`); empty → no status section. */
  statusLines: string[];
  /** The capture action items (DEV-1: Quick Capture · Hotkey-unavailable · Enable-selection · Show Vellum). */
  actionItems: MenuItemConstructorOptions[];
  /** Optional appended items (DEV-2's QUIESCE-6 "Prepare for shutdown / Resume"); empty when unused. */
  extraItems?: MenuItemConstructorOptions[];
}): MenuItemConstructorOptions[] {
  const status: MenuItemConstructorOptions[] = opts.statusLines.map((label) => ({ label, enabled: false }));
  const extra = opts.extraItems ?? [];
  return [
    ...status,
    ...(status.length ? [separator()] : []),
    ...opts.actionItems,
    ...(extra.length ? [separator(), ...extra] : []),
    separator(),
    { label: 'Quit Vellum', role: 'quit' },
  ];
}
