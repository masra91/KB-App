// e2e smoke for SPEC-0029 Audit & Activity (AUDIT-8/9). Drives the production-built app with a
// pre-configured KB so it boots to the shell, then asserts the read-only **Activity** view is wired
// into the REAL navigation rail as a top-level sibling (next to Reviews) and mounts when selected —
// the shell integration the component tier (activityView.test.ts) can't cover. The feed's contents
// depend on an active pipeline writing audit (a git-backed vault + staging worktree); this seed is a
// minimal non-git vault, so we assert the rail entry + view mount + empty state, not live rows (the
// feed/drill-down/filter/lineage round-trips are covered by the component + node tiers). e2e is
// CI-only (SPEC-0012 TEST-9).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-activity-'));
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
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-activity-vault-'));
  fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.kb', 'config.json'),
    JSON.stringify({ schemaVersion: 1, id: 'e2e-activity-kb', name: 'E2E Activity KB', createdAt: '2026-06-02T00:00:00.000Z' }, null, 2),
  );
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');
  return vault;
}

test.describe('AUDIT-9 — the Activity view is wired into the shell (read-only)', () => {
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

  test('opens the Activity view from the rail and renders the read-only observatory', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshUserDataDir();
    vaultDir = seedConfiguredKb(userDataDir);

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Configured KB ⇒ shell (not Setup). Activity is a top-level rail entry (no Manage group).
    const activityNav = window.locator('.nav-item[data-view="activity"]');
    await expect(activityNav).toBeVisible({ timeout: 15_000 });

    // Selecting Activity mounts the read-only view; with no audit yet it shows the empty state.
    await activityNav.click();
    const view = window.locator('.view[data-view="activity"]');
    await expect(view.locator('h1')).toContainText('Activity');
    await expect(view.locator('.activity-empty')).toBeVisible();
  });
});
