// Electron-backed QuickCaptureDeps (SPEC-0038) — the thin platform glue the QuickCaptureAgent drives
// (the behavior + invariants live in quickCaptureAgent.ts, unit-tested). Owns: global hotkey
// registration (conflict = register returns false → agent degrades, QCAP-9), the always-present
// menubar/tray entry (QCAP-3), the frameless capture sheet window (loads the shared renderer at the
// `#qcap` route, QCAP-4 headless), and focus-restore to the prior app on dismiss (QCAP-2, macOS app.hide).
import { app, globalShortcut, Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import path from 'node:path';
import type { QuickCaptureDeps } from './quickCaptureAgent';

export interface ElectronQcapHooks {
  /** Open the sheet (wired to the agent; used by the tray menu item). */
  onOpen: () => void;
  /** Dismiss + restore focus (wired to the agent; used by sheet blur — click-away dismiss). */
  onClose: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

function createSheetWindow(onBlur: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 200,
    frame: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // Load the shared renderer at the #qcap route (no separate Vite entry — same preload/kbApi).
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#qcap`);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { hash: 'qcap' });
  }
  // Frictionless: clicking away dismisses (Spotlight-like). Guarded so app.hide()'s blur can't loop.
  win.on('blur', () => {
    if (!win.isDestroyed()) onBlur();
  });
  return win;
}

export function electronQuickCaptureDeps(hooks: ElectronQcapHooks): QuickCaptureDeps {
  let sheet: BrowserWindow | null = null;
  let tray: Tray | null = null;

  return {
    registerHotkey(accelerator, onTrigger) {
      try {
        // globalShortcut.register returns false when the OS/another app already owns the accelerator.
        return globalShortcut.register(accelerator, onTrigger);
      } catch {
        return false; // an invalid/unsupported accelerator → treated as unavailable (QCAP-9 degrade)
      }
    },
    unregisterHotkey(accelerator) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* best-effort */
      }
    },
    showSheet() {
      // Create fresh each summon so the renderer re-inits (clipboard re-read, empty field). Headless:
      // depends on nothing but this window (QCAP-4).
      if (!sheet || sheet.isDestroyed()) {
        sheet = createSheetWindow(hooks.onClose);
      }
      const w = sheet;
      w.once('ready-to-show', () => {
        if (!w.isDestroyed()) {
          w.center();
          w.show();
          w.focus();
        }
      });
      if (!w.isVisible()) {
        // already ready (re-show path)
        try {
          w.center();
          w.show();
          w.focus();
        } catch {
          /* ready-to-show will handle it */
        }
      }
    },
    hideSheet() {
      if (sheet && !sheet.isDestroyed()) sheet.destroy();
      sheet = null;
    },
    restoreFocus() {
      // macOS: hiding the app returns key focus to the previously-active app (QCAP-2). Elsewhere the
      // window destroy already yields focus.
      if (process.platform === 'darwin') {
        try {
          app.hide();
        } catch {
          /* best-effort */
        }
      }
    },
    setTray(state) {
      if (!tray) {
        // An empty image + a short menubar title keeps the entry visible without a bundled icon asset
        // (a proper template icon is a polish follow-up). The tray is the always-present entry (QCAP-3).
        tray = new Tray(nativeImage.createEmpty());
        tray.setToolTip('KB-App — Quick Capture');
        if (process.platform === 'darwin') tray.setTitle('⤓');
      }
      const accel = state.hotkeyAccelerator;
      const menu = Menu.buildFromTemplate([
        {
          label: accel ? `Quick Capture  (${accel})` : 'Quick Capture',
          ...(accel ? { accelerator: accel } : {}),
          click: () => hooks.onOpen(),
        },
        ...(accel
          ? []
          : [{ label: 'Hotkey unavailable — use this menu', enabled: false } as Electron.MenuItemConstructorOptions]),
        { type: 'separator' as const },
        { label: 'Quit KB-App', role: 'quit' as const },
      ]);
      tray.setContextMenu(menu);
    },
    log: hooks.log,
  };
}
