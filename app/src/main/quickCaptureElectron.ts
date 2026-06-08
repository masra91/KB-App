// Electron-backed QuickCaptureDeps (SPEC-0038) — the thin platform glue the QuickCaptureAgent drives
// (the behavior + invariants live in quickCaptureAgent.ts, unit-tested). Owns: global hotkey
// registration (conflict = register returns false → agent degrades, QCAP-9), the always-present
// menubar/tray entry (QCAP-3), the frameless capture sheet window (loads the shared renderer at the
// `#qcap` route, QCAP-4 headless), and focus-restore to the prior app on dismiss (QCAP-2, macOS app.hide).
import { app, globalShortcut, Tray, Menu, BrowserWindow, nativeImage, screen, systemPreferences, clipboard, shell } from 'electron';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { QuickCaptureDeps, SelectionRead } from './quickCaptureAgent';

const execFileP = promisify(execFile);

/** macOS Privacy panes (SPEC-0034 / QCAP-9 steer-to-Settings) — exact anchor with a general fallback. */
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy';

/** Is this process a trusted macOS Accessibility client right now? (false off-darwin / when not granted.) */
function accessibilityGranted(): boolean {
  return process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * Read the focused app's current text selection on macOS (SPEC-0038 QCAP-7/9, Slice 2). The honest
 * mechanism with NO native module (per E1 — a native addon also broke the mac package build before):
 * gate on the Accessibility grant, then post a synthetic ⌘C through System Events (which the grant
 * unlocks) and read the pasteboard — saving + restoring the user's clipboard so the read is
 * non-destructive. Bounded by a short timeout so a stuck `osascript` can't stall the summon
 * (preserves the QCAP-2 fast-out feel). Any failure → degrade to `denied`/`unsupported` (clipboard-only).
 */
async function readFocusedSelection(): Promise<SelectionRead> {
  if (process.platform !== 'darwin') return { status: 'unsupported', text: null };
  // Probe WITHOUT prompting — a system prompt on every summon would be hostile. The explicit request
  // lives on the tray's "Enable selection capture…" item + the sheet's steer-to-Settings affordance.
  if (!systemPreferences.isTrustedAccessibilityClient(false)) return { status: 'denied', text: null };

  const saved = clipboard.readText(); // restore this afterward — selection-read must not eat the clipboard
  try {
    await execFileP('osascript', ['-e', 'tell application "System Events" to keystroke "c" using {command down}'], {
      timeout: 1200,
    });
    await delay(120); // give the frontmost app a beat to place the copy on the pasteboard
    const text = clipboard.readText();
    clipboard.writeText(saved); // restore the user's clipboard (best-effort, non-destructive)
    // Unchanged pasteboard = no live selection (or the app ignored ⌘C) → null, sheet falls to clipboard.
    if (!text || text === saved) return { status: 'granted', text: null };
    return { status: 'granted', text };
  } catch {
    clipboard.writeText(saved); // restore even if the keystroke post / read failed
    return { status: 'denied', text: null }; // couldn't post the copy → treat as not-granted, degrade
  }
}

/** DESIGN-QCAP §2: command-bar proportions — a narrow sheet that reads as a summoned tool. */
const SHEET_WIDTH = 520;
const SHEET_HEIGHT = 200;

/** DESIGN-QCAP §2/§10: anchor the sheet in the upper third of the focused display (command-bar
 *  convention) — never centered like a blocking modal. Chosen for hotkey-summon consistency. */
function anchorUpperThird(win: BrowserWindow): void {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    const x = Math.round(wa.x + (wa.width - SHEET_WIDTH) / 2);
    const y = Math.round(wa.y + wa.height / 3 - SHEET_HEIGHT / 2);
    win.setPosition(x, y);
  } catch {
    win.center(); // fall back to centered if display geometry is unavailable
  }
}

export interface ElectronQcapHooks {
  /** Open the sheet (wired to the agent; used by the tray menu item). */
  onOpen: () => void;
  /** Dismiss + restore focus (wired to the agent; used by sheet blur — click-away dismiss). */
  onClose: () => void;
  /** QCAP-11: restore/focus (create-if-none) the main window — the menubar "Show KB-App" item. */
  onShowMainWindow?: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

function createSheetWindow(onBlur: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: SHEET_WIDTH,
    height: SHEET_HEIGHT,
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
          anchorUpperThird(w);
          w.show();
          w.focus();
        }
      });
      if (!w.isVisible()) {
        // already ready (re-show path)
        try {
          anchorUpperThird(w);
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
    // Slice 2 (QCAP-7/9): the agent calls this on summon, before the sheet steals focus. Never throws
    // the summon dead — readFocusedSelection degrades to denied/unsupported on any failure.
    readSelection() {
      return readFocusedSelection();
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
      // QCAP-9 (Slice 2): when selection-capture isn't yet granted, offer an explicit enable path from
      // the always-present menubar (never a silent dead feature) — the native prompt + a steer to the
      // Settings·Privacy·Accessibility pane. Hidden once granted. Off-darwin the item never appears.
      const needsAccessibility = process.platform === 'darwin' && !accessibilityGranted();
      const menu = Menu.buildFromTemplate([
        {
          label: accel ? `Quick Capture  (${accel})` : 'Quick Capture',
          ...(accel ? { accelerator: accel } : {}),
          click: () => hooks.onOpen(),
        },
        ...(accel
          ? []
          : [{ label: 'Hotkey unavailable — use this menu', enabled: false } as Electron.MenuItemConstructorOptions]),
        ...(needsAccessibility
          ? [
              { type: 'separator' as const },
              {
                label: 'Enable selection capture…',
                click: () => {
                  // Trigger the native Accessibility prompt, then steer to the pane (flaky anchor → fallback).
                  systemPreferences.isTrustedAccessibilityClient(true);
                  void shell.openExternal(ACCESSIBILITY_PANE).catch(() => {
                    void shell.openExternal(PRIVACY_PANE);
                  });
                },
              } as Electron.MenuItemConstructorOptions,
            ]
          : []),
        { type: 'separator' as const },
        // QCAP-11: restore the main window from the menubar so the LSUIElement accessory is never a
        // one-way trap. Plain instrument-voice label (design §4) — no icon/badge. onShowMainWindow
        // creates the window if none exists; omitted in tests/headless → the item is simply absent.
        ...(hooks.onShowMainWindow
          ? [{ label: 'Show KB-App', click: () => hooks.onShowMainWindow?.() } as Electron.MenuItemConstructorOptions]
          : []),
        { type: 'separator' as const },
        { label: 'Quit KB-App', role: 'quit' as const },
      ]);
      tray.setContextMenu(menu);
    },
    log: hooks.log,
  };
}
