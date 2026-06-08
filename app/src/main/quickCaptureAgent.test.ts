// Quick Capture agent tests (SPEC-0038 QCAP). Pure — drives the agent against a fake platform
// seam, so the load-bearing invariants are asserted without launching Electron.
import { describe, it, expect, vi } from 'vitest';
import {
  QuickCaptureAgent,
  normalizeAccelerator,
  normalizeAcceleratorOrDefault,
  DEFAULT_QUICK_CAPTURE_ACCELERATOR,
  type QuickCaptureDeps,
} from './quickCaptureAgent';

interface FakeLog {
  tray: { hotkeyAccelerator: string | null }[];
  shown: number;
  hidden: number;
  focusRestored: number;
}
type FakeDeps = QuickCaptureDeps & { registered: Map<string, () => void>; calls: FakeLog };

function fakeDeps(overrides: Partial<QuickCaptureDeps> = {}): FakeDeps {
  const registered = new Map<string, () => void>();
  const log: FakeLog = { tray: [], shown: 0, hidden: 0, focusRestored: 0 };
  const deps: QuickCaptureDeps = {
    registerHotkey: (accel, onTrigger) => {
      registered.set(accel, onTrigger);
      return true;
    },
    unregisterHotkey: (accel) => {
      registered.delete(accel);
    },
    showSheet: () => {
      log.shown += 1;
    },
    hideSheet: () => {
      log.hidden += 1;
    },
    restoreFocus: () => {
      log.focusRestored += 1;
    },
    setTray: (s) => {
      log.tray.push(s);
    },
    ...overrides,
  };
  return Object.assign(deps, { registered, calls: log });
}

describe('normalizeAccelerator (QCAP-6)', () => {
  it('accepts modifier+key and canonicalizes (Option→Alt, key uppercased)', () => {
    expect(normalizeAccelerator('Alt+Space')).toBe('Alt+Space');
    expect(normalizeAccelerator('option+space')).toBe('Alt+Space');
    expect(normalizeAccelerator('CmdOrCtrl+k')).toBe('CommandOrControl+K');
    expect(normalizeAccelerator('Control+Shift+J')).toBe('Control+Shift+J');
    expect(normalizeAccelerator('Cmd+F5')).toBe('Command+F5');
  });

  it('rejects a bare key (no modifier) — a global hotkey must not hijack a plain key', () => {
    expect(normalizeAccelerator('Space')).toBeNull();
    expect(normalizeAccelerator('A')).toBeNull();
  });

  it('rejects an unknown modifier or empty input', () => {
    expect(normalizeAccelerator('Hyper+Space')).toBeNull();
    expect(normalizeAccelerator('')).toBeNull();
    expect(normalizeAccelerator('Alt+')).toBeNull();
  });

  it('falls back to the shipped default for invalid input', () => {
    expect(normalizeAcceleratorOrDefault('nonsense')).toBe(DEFAULT_QUICK_CAPTURE_ACCELERATOR);
    expect(normalizeAcceleratorOrDefault(undefined)).toBe('Alt+Space');
    expect(normalizeAcceleratorOrDefault('option+space')).toBe('Alt+Space');
  });
});

describe('QuickCaptureAgent', () => {
  it('start() registers the hotkey AND builds the menubar entry (QCAP-3)', () => {
    const deps = fakeDeps();
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    const r = agent.start();
    expect(r).toEqual({ ok: true, conflict: false, accelerator: 'Alt+Space' });
    expect(agent.hotkeyActive()).toBe(true);
    expect(deps.registered.has('Alt+Space')).toBe(true);
    expect(deps.calls.tray.at(-1)).toEqual({ hotkeyAccelerator: 'Alt+Space' });
  });

  it('QCAP-1/4: the hotkey opens the sheet; open() works headless (only the seam, no main window)', () => {
    const deps = fakeDeps();
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    agent.start();
    deps.registered.get('Alt+Space')!(); // simulate the OS firing the hotkey
    expect(deps.calls.shown).toBe(1);
    agent.open(); // menubar path
    expect(deps.calls.shown).toBe(2);
  });

  it('QCAP-9: a hotkey CONFLICT degrades — not live, but the menubar entry is still built (never silently dead)', () => {
    const deps = fakeDeps({ registerHotkey: () => false }); // OS/other app already owns it
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    const r = agent.start();
    expect(r).toEqual({ ok: false, conflict: true, accelerator: 'Alt+Space' });
    expect(agent.hotkeyActive()).toBe(false); // NOT recorded as live
    expect(agent.activeAccelerator()).toBeNull();
    expect(deps.calls.tray.at(-1)).toEqual({ hotkeyAccelerator: null }); // tray still built → menubar capture works
    // The menubar path still opens the sheet despite the dead hotkey.
    agent.open();
    expect(deps.calls.shown).toBe(1);
  });

  it('QCAP-6: setAccelerator re-registers conflict-aware (unregisters old, registers new)', () => {
    const deps = fakeDeps();
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    agent.start();
    const r = agent.setAccelerator('CmdOrCtrl+Shift+K');
    expect(r.ok).toBe(true);
    expect(r.accelerator).toBe('CommandOrControl+Shift+K');
    expect(deps.registered.has('Alt+Space')).toBe(false); // old unregistered
    expect(deps.registered.has('CommandOrControl+Shift+K')).toBe(true);
    expect(agent.activeAccelerator()).toBe('CommandOrControl+Shift+K');
  });

  it('QCAP-6: an invalid new accelerator degrades cleanly (not live), tray reflects it', () => {
    const deps = fakeDeps();
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    agent.start();
    const r = agent.setAccelerator('garbage');
    expect(r.ok).toBe(false);
    expect(agent.hotkeyActive()).toBe(false);
    expect(deps.calls.tray.at(-1)).toEqual({ hotkeyAccelerator: null });
  });

  it('QCAP-2: close() hides the sheet AND restores focus to the prior app', () => {
    const deps = fakeDeps();
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    agent.start();
    agent.open();
    agent.close();
    expect(deps.calls.hidden).toBe(1);
    expect(deps.calls.focusRestored).toBe(1);
  });

  it('logs a conflict (observable, not swallowed)', () => {
    const log = vi.fn();
    const deps = fakeDeps({ registerHotkey: () => false, log });
    new QuickCaptureAgent(deps, 'Alt+Space').start();
    expect(log).toHaveBeenCalledWith('qcap.hotkey.conflict', { accelerator: 'Alt+Space' });
  });

  it('stop() unregisters the live hotkey', () => {
    const deps = fakeDeps();
    const agent = new QuickCaptureAgent(deps, 'Alt+Space');
    agent.start();
    agent.stop();
    expect(deps.registered.has('Alt+Space')).toBe(false);
    expect(agent.hotkeyActive()).toBe(false);
  });
});
