// e2e smoke for SPEC-0027 Control Panel slice 1 (PANEL-1). Drives the production-built app with a
// pre-configured KB so it boots to the shell, then asserts the "Manage" section is wired into the
// REAL navigation rail and the Jobs view mounts when selected — the shell integration the component
// tier (jobsView.test.ts) can't cover. Job rows depend on an active pipeline (a git-backed vault +
// staging worktree); this seed is a minimal non-git vault, so we assert the section + view mount,
// not live rows (the enable→persist round-trip is covered by the component + node tiers). e2e is
// CI-only (SPEC-0012 TEST-9).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-jobs-'));
}

function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

/** Seed a configured (non-onboarding) KB so the renderer mounts the shell, not Setup (SETUP-6). */
function seedConfiguredKb(userDataDir: string): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-jobs-vault-'));
  fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.kb', 'config.json'),
    JSON.stringify({ schemaVersion: 1, id: 'e2e-jobs-kb', name: 'E2E Jobs KB', createdAt: '2026-06-02T00:00:00.000Z' }, null, 2),
  );
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');
  return vault;
}

test.describe('PANEL-1 — the Manage section is wired into the shell', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string | null = null;
  let vaultDir: string | null = null;

  test.afterEach(async () => {
    await app?.close();
    app = null;
    if (vaultDir) rmDirBestEffort(vaultDir);
    if (userDataDir) rmDirBestEffort(userDataDir);
    userDataDir = vaultDir = null;
  });

  test('shows a Manage section and opens the Jobs view from the rail', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshUserDataDir();
    vaultDir = seedConfiguredKb(userDataDir);

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Configured KB ⇒ shell (not Setup). The Manage heading + the Manage views are in the rail.
    await expect(window.locator('.sidebar .nav-group')).toHaveText('Manage', { timeout: 15_000 });
    const jobsNav = window.locator('.nav-item[data-view="jobs"]');
    await expect(jobsNav).toBeVisible();
    await expect(window.locator('.nav-item[data-view="settings"]')).toBeVisible();

    // Selecting Jobs mounts the Jobs view.
    await jobsNav.click();
    await expect(window.locator('.view[data-view="jobs"] h1')).toContainText('Jobs');
  });
});
