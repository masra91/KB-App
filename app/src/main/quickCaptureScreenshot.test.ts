// SPEC-0038 QCAP-13 — screenshot handle-registry security tests. The cardinal property: the main
// process reads back ONLY a temp-PNG handle it issued — never an arbitrary renderer-supplied path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';

const state = vi.hoisted(() => ({ tempDir: '', imageEmpty: false, png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }));

vi.mock('electron', () => ({
  app: { getPath: (): string => state.tempDir },
  systemPreferences: { getMediaAccessStatus: (): string => 'denied' },
  clipboard: {
    readImage: () => ({ isEmpty: (): boolean => state.imageEmpty, toPNG: (): Buffer => Buffer.from(state.png) }),
  },
}));

import { clipboardImageHandle, consumeScreenshotHandle, isIssuedHandle } from './quickCaptureScreenshot';

describe('QCAP-13 screenshot handle registry (security boundary)', () => {
  beforeEach(async () => {
    state.tempDir = await makeTempDir('kb-shot-');
    state.imageEmpty = false;
  });
  afterEach(async () => {
    await rmTempDir(state.tempDir);
  });

  it('an issued handle round-trips: consume reads the bytes then DELETES + de-registers it', async () => {
    const issued = await clipboardImageHandle();
    expect(issued).not.toBeNull();
    expect(isIssuedHandle(issued!.handle)).toBe(true);
    await expect(fs.access(issued!.handle)).resolves.toBeUndefined(); // temp PNG written

    const bytes = await consumeScreenshotHandle(issued!.handle);
    expect(bytes).toEqual(state.png);
    expect(isIssuedHandle(issued!.handle)).toBe(false); // de-registered
    await expect(fs.access(issued!.handle)).rejects.toThrow(); // temp file removed (no leak)
  });

  it('consume is single-use — a second consume of the same handle returns null (no replay)', async () => {
    const issued = await clipboardImageHandle();
    await consumeScreenshotHandle(issued!.handle);
    expect(await consumeScreenshotHandle(issued!.handle)).toBeNull();
  });

  it('SECURITY: consume of a handle we did NOT issue returns null (never reads an arbitrary path)', async () => {
    // Even a real, readable file on disk is refused unless it was issued by THIS module.
    const planted = `${state.tempDir}/not-issued.png`;
    await fs.writeFile(planted, 'secret');
    expect(isIssuedHandle(planted)).toBe(false);
    expect(await consumeScreenshotHandle(planted)).toBeNull();
    await expect(fs.access(planted)).resolves.toBeUndefined(); // and it is NOT deleted (we never touched it)
  });

  it('clipboardImageHandle returns null when the clipboard holds no image', async () => {
    state.imageEmpty = true;
    expect(await clipboardImageHandle()).toBeNull();
  });
});
