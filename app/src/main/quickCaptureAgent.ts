// Quick Capture (SPEC-0038 QCAP) — the platform-agnostic agent that owns the global hotkey +
// menubar entry + capture sheet lifecycle. ALL behavior lives here behind an injected
// `QuickCaptureDeps` seam (Electron's globalShortcut/Tray/BrowserWindow/app are the real deps),
// so the load-bearing invariants are unit-testable WITHOUT launching Electron:
//   - QCAP-6  hotkey is configurable + CONFLICT-AWARE (a clash never reads as a live hotkey)
//   - QCAP-9  denied/unavailable hotkey DEGRADES to the menubar entry — never silently dead
//   - QCAP-4  open works headless (no main window) — the agent only depends on the seam
//   - QCAP-2  dismiss restores focus to the prior app
// QCAP adds NO preservation logic — the sheet delivers onto the SPEC-0013 capture path (QCAP-1).
import { DEFAULT_QUICK_CAPTURE_ACCELERATOR } from '../kb/instanceConfig';

/** The shipped default global hotkey (fork #1 — Principal's pick: ⌥Space). User-configurable (QCAP-6). */
export { DEFAULT_QUICK_CAPTURE_ACCELERATOR };

const MODIFIERS: Record<string, string> = {
  command: 'Command', cmd: 'Command',
  control: 'Control', ctrl: 'Control',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  alt: 'Alt', option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Meta',
};

const NAMED_KEYS: Record<string, string> = Object.fromEntries(
  [
    'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
    'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'Plus', 'CapsLock', 'NumLock', 'PrintScreen',
    'ScrollLock', 'Pause',
  ].map((k) => [k.toLowerCase(), k]),
);

function canonKey(key: string): string | null {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  // A single printable punctuation key is a valid Electron accelerator key (e.g. `/`, `,`).
  if (key.length === 1 && /[!-~]/.test(key)) return key;
  return null;
}

/**
 * Normalize an Electron accelerator to canonical form, or null if invalid (QCAP-6). Requires at
 * least one modifier + a key — a bare-key global hotkey (e.g. just `Space`) would hijack that key
 * system-wide, so it's rejected rather than registered into a footgun.
 */
export function normalizeAccelerator(accel: string): string | null {
  if (typeof accel !== 'string') return null;
  const parts = accel.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return null; // need ≥1 modifier + a key
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const canonMods: string[] = [];
  for (const m of mods) {
    const c = MODIFIERS[m.toLowerCase()];
    if (!c) return null;
    if (!canonMods.includes(c)) canonMods.push(c);
  }
  const canonK = canonKey(key);
  if (!canonK) return null;
  return [...canonMods, canonK].join('+');
}

/** Normalize, falling back to the shipped default for an invalid/empty value. */
export function normalizeAcceleratorOrDefault(accel: string | undefined | null): string {
  return (typeof accel === 'string' && normalizeAccelerator(accel)) || DEFAULT_QUICK_CAPTURE_ACCELERATOR;
}

/** The platform seam the agent drives (Electron-backed in prod; faked in tests). */
export interface QuickCaptureDeps {
  /** Register a global hotkey; returns false when the OS/another app already owns it (conflict). */
  registerHotkey(accelerator: string, onTrigger: () => void): boolean;
  unregisterHotkey(accelerator: string): void;
  /** Create-if-needed + show + focus the capture sheet (works with no main window — headless). */
  showSheet(): void;
  hideSheet(): void;
  /** Return focus to the previously-active app (macOS: app.hide()). */
  restoreFocus(): void;
  /** Build/refresh the always-present menubar entry (QCAP-3) — reflects whether the hotkey is live. */
  setTray(state: { hotkeyAccelerator: string | null }): void;
  log?(event: string, data?: Record<string, unknown>): void;
}

/** Outcome of (re)registering the hotkey — `conflict` drives the QCAP-6 warn + QCAP-9 degrade. */
export interface HotkeyResult {
  ok: boolean;
  conflict: boolean;
  accelerator: string;
}

export class QuickCaptureAgent {
  /** The accelerator currently registered + live; null when degraded (invalid/conflict) — QCAP-9. */
  private accel: string | null = null;
  private readonly deps: QuickCaptureDeps;
  private desired: string;

  constructor(deps: QuickCaptureDeps, initialAccelerator: string = DEFAULT_QUICK_CAPTURE_ACCELERATOR) {
    this.deps = deps;
    this.desired = normalizeAcceleratorOrDefault(initialAccelerator);
  }

  /** Register the hotkey + build the menubar entry. The tray is built UNCONDITIONALLY (QCAP-3/9):
   *  even if the hotkey conflicts, capture stays reachable via the menubar — never silently dead. */
  start(): HotkeyResult {
    const r = this.register(this.desired);
    this.deps.setTray({ hotkeyAccelerator: this.accel });
    return r;
  }

  private register(accelerator: string): HotkeyResult {
    const norm = normalizeAccelerator(accelerator);
    if (!norm) {
      this.accel = null;
      this.deps.log?.('qcap.hotkey.invalid', { accelerator });
      return { ok: false, conflict: false, accelerator };
    }
    this.desired = norm;
    const ok = this.deps.registerHotkey(norm, () => this.open());
    this.accel = ok ? norm : null; // QCAP-9: a conflicting hotkey is NEVER recorded as live
    if (!ok) this.deps.log?.('qcap.hotkey.conflict', { accelerator: norm });
    return { ok, conflict: !ok, accelerator: norm };
  }

  /** Reconfigure the hotkey at runtime (Settings, QCAP-6) — unregisters the old, registers the new,
   *  conflict-aware. The menubar entry refreshes so a degraded hotkey is visible, not silent. */
  setAccelerator(accelerator: string): HotkeyResult {
    if (this.accel) this.deps.unregisterHotkey(this.accel);
    const r = this.register(accelerator);
    this.deps.setTray({ hotkeyAccelerator: this.accel });
    return r;
  }

  /** Summon the capture sheet (hotkey or menubar). Headless-safe — depends only on the seam (QCAP-4). */
  open(): void {
    this.deps.showSheet();
  }

  /** Dismiss the sheet + restore focus to the prior app (QCAP-2). */
  close(): void {
    this.deps.hideSheet();
    this.deps.restoreFocus();
  }

  /** Whether the global hotkey is currently live (false = degraded to menubar-only, QCAP-9). */
  hotkeyActive(): boolean {
    return this.accel !== null;
  }

  /** The live accelerator, or null when degraded. */
  activeAccelerator(): string | null {
    return this.accel;
  }

  stop(): void {
    if (this.accel) this.deps.unregisterHotkey(this.accel);
    this.accel = null;
  }
}
