// @vitest-environment happy-dom
//
// Capture view — the MACOS-7 / #56 blocked-capture recovery (component tier). When a capture write hits
// a macOS folder-permission denial, the capture panel must route to the Blocked recovery (brass,
// actionable) instead of surfacing the raw OS error — never a dead-end, never dev jargon.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountCapture } from './captureView';
import type { KbApi, CaptureResult } from '../../kb/types';

function setApi(captureResult: CaptureResult): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    capture: vi.fn().mockResolvedValue(captureResult),
    pipelineStatus: vi.fn().mockResolvedValue({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null }),
    probeVaultAccess: vi.fn().mockResolvedValue({ ok: true, denied: false, message: 'ok' }),
    openSystemSettingsPrivacy: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('captureView — blocked-capture recovery (MACOS-7 / #56)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  it('a permission-denied capture routes to the Blocked recovery (no raw OS error, no silent stall)', async () => {
    setApi({ ok: false, blocked: true, ids: [], captureBatch: null, committed: false, message: 'KB-App can’t write to your vault folder — access is turned off.' });
    mountCapture(root, '/Users/me/Documents/MyVault', 'KB');
    (root.querySelector('#captureText') as HTMLTextAreaElement).value = 'a thought';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await Promise.resolve(); await Promise.resolve();

    expect(root.querySelector('.perm-blocked')).not.toBeNull(); // Blocked recovery mounted in place
    expect(root.querySelector('#perm-open-settings')).not.toBeNull();
    expect(root.querySelector('#perm-retry')).not.toBeNull();
    expect(root.textContent).not.toContain('Operation not permitted'); // raw OS text never shown
  });

  it('a successful capture clears the input + confirms (no Blocked surface)', async () => {
    setApi({ ok: true, blocked: false, ids: ['1'], captureBatch: 'b1', committed: true, message: 'Captured 1 item(s).' });
    mountCapture(root, '/v', 'KB');
    const ta = root.querySelector('#captureText') as HTMLTextAreaElement;
    ta.value = 'x';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await Promise.resolve(); await Promise.resolve();

    expect(root.querySelector('.perm-blocked')).toBeNull();
    expect(ta.value).toBe('');
    expect(root.querySelector('#captureNote')!.textContent).toContain('Captured 1 item');
  });
});
