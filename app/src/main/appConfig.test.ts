// SPEC-0009 SETUP-6 — the app-level config (which vault is active) is persisted in
// Electron's userData, so a later launch loads the existing KB instead of re-onboarding.
// `app.getPath('userData')` is mocked to a throwaway temp dir; the real fs round-trips
// through it, proving the config survives a (simulated) process restart.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return state.userData;
    },
  },
}));

import { readAppConfig, writeAppConfig } from './appConfig';

const CONFIG_FILE = 'kb-app.config.json';

describe('appConfig persistence (SETUP-6)', () => {
  beforeEach(async () => {
    state.userData = await makeTempDir('kb-userdata-');
  });
  afterEach(async () => {
    await rmTempDir(state.userData);
  });

  it('first run: no config file yet → defaults to no active vault (setup is shown)', async () => {
    expect(await readAppConfig()).toEqual({ activeVaultPath: null });
  });

  it('persists activeVaultPath; a later launch reads the same vault back (no re-onboarding)', async () => {
    const vault = '/Users/principal/my-kb';

    await writeAppConfig({ activeVaultPath: vault });

    // The config lives in userData — it outlives the process, so a fresh launch sees it.
    expect(await pathExists(path.join(state.userData, CONFIG_FILE))).toBe(true);
    expect((await readAppConfig()).activeVaultPath).toBe(vault);
  });

  it('falls back to the default (not a crash) when the persisted config is corrupt', async () => {
    await fs.writeFile(path.join(state.userData, CONFIG_FILE), '{ this is not json');
    expect(await readAppConfig()).toEqual({ activeVaultPath: null });
  });
});
