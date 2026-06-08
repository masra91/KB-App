// QCAP-8 — Dock + tray dual-model lifecycle policy + the LSUIElement (Dock-presence) config guard.
// Real-path regressions for the Principal's "app stopped showing in the macOS Dock" + the menubar
// persistence: window-all-closed must NOT quit on macOS, and the packaged app must ship with the Dock
// icon (LSUIElement=false), not as a hidden accessory.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shouldQuitOnWindowAllClosed } from './lifecycle';

describe('QCAP-8 dual-model — window-all-closed stays alive on macOS', () => {
  it('macOS does NOT quit on window-all-closed (stays alive as a Dock + tray agent)', () => {
    expect(shouldQuitOnWindowAllClosed('darwin')).toBe(false);
  });
  it('other platforms quit on window-all-closed as usual', () => {
    expect(shouldQuitOnWindowAllClosed('win32')).toBe(true);
    expect(shouldQuitOnWindowAllClosed('linux')).toBe(true);
  });
});

describe('QCAP-8 Dock-presence — the LSUIElement regression guard', () => {
  // The Principal's bug: the app shipped as a macOS accessory (LSUIElement=true → no Dock icon).
  // QCAP-8 requires LSUIElement=false so the Dock icon shows. Guard the forge packaging config so it
  // can't silently flip back to accessory mode.
  const forgeConfig = readFileSync(path.join(__dirname, '../../forge.config.ts'), 'utf8');

  it('packages with the Dock icon: extendInfo.LSUIElement is false, never true', () => {
    expect(forgeConfig).toMatch(/LSUIElement:\s*false/);
    expect(forgeConfig).not.toMatch(/LSUIElement:\s*true/); // never the hidden-accessory mode again
  });
});
