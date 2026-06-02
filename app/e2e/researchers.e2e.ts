// e2e smoke for SPEC-0028 RESEARCH-15 — the Researchers Manage view is wired into the production
// shell. Drives the built app with a pre-configured KB so it boots to the shell, opens the
// Manage → Researchers view from the real rail, and asserts it mounts with the add-from-template
// control. Row management / run-now round-trips are covered by the node + happy-dom tiers; this is
// the shell-integration smoke (CI-only, SPEC-0012 TEST-9).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-researchers-'));
}
function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}
function seedConfiguredKb(userDataDir: string): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-researchers-vault-'));
  fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.kb', 'config.json'), JSON.stringify({ schemaVersion: 1, id: 'e2e-researchers-kb', name: 'E2E Researchers KB', createdAt: '2026-06-02T00:00:00.000Z' }, null, 2));
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');
  return vault;
}

test.describe('RESEARCH-15 — the Researchers view is wired into the Manage shell', () => {
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

  test('opens Researchers from the Manage rail and mounts the add-from-template surface', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();
    userDataDir = freshUserDataDir();
    vaultDir = seedConfiguredKb(userDataDir);

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const researchersNav = window.locator('.nav-item[data-view="researchers"]');
    await expect(researchersNav).toBeVisible({ timeout: 15_000 });
    await researchersNav.click();

    const view = window.locator('.view[data-view="researchers"]');
    await expect(view.locator('h1')).toContainText('Researchers');
    // A minimal (non-git) seeded vault has no researchers → empty state + the add control is present.
    await expect(view.locator('.researcher-add')).toBeVisible();
  });
});
