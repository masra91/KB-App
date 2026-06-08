// QCAP-8 — macOS Dock + tray DUAL-MODEL lifecycle policy. The app is a normal **windowed Dock app**
// (`LSUIElement=false`, set in forge.config.ts → Dock icon, Cmd-Tab, app menu) AND a **persistent
// menubar/tray agent**: closing the last window must NOT quit on macOS — the app stays alive with the
// background pipeline + global hotkey running (QCAP-4), and the tray "Show KB-App" (QCAP-11) / hotkey
// reopen the window. Other platforms quit on window-all-closed as usual.
//
// (The Principal's "app stopped showing in the macOS Dock" was the old `LSUIElement=true` accessory
// mode hiding it; QCAP-8 restores Dock presence AND keeps tray persistence — "do both".)
//
// Pure + unit-tested; main.ts wires it into the `window-all-closed` app event.

/** Should the app quit when the last window closes? macOS = NO (Dock + tray agent stays alive,
 *  QCAP-8); every other platform = yes. */
export function shouldQuitOnWindowAllClosed(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}
