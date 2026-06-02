// e2e smoke for SPEC-0028 RESEARCH-15 — "The Field Desk" Researchers Manage view is wired into the
// production shell. Drives the built app with a pre-configured KB so it boots to the shell, opens the
// Manage → Researchers view from the real rail, and asserts it mounts as the redesigned surface +
// holds the §6 anti-generic guardrail (NO native <select>) on the real packaged build. Row management
// / run-now round-trips are covered by the node + happy-dom tiers; this is the shell-integration smoke
// (CI-only, SPEC-0012 TEST-9).
//
// LIVE Run-now → typed report (the #160/#180 honesty in the packaged view): authoring a full Run-now
// flow here needs a git-backed + pipeline-started vault (so the staging worktree provisions). The
// stable selectors for that flow, for a BYOA pass (DEV-2):
//   - add:   .rdesk-tile[data-template="web"] → fill .researcher-add-id → re-click the tile (dispatch)
//   - strip: .rdesk-strip[data-id="<slug>"]   (slug of the typed name)
//   - run:   .researcher-run  →  confirm .researcher-confirm-go
//   - report:.researcher-status  (no copilot → "Couldn't run …" = failed≠empty #160; BYOA → "Brought
//            back N"); the persisted last-run reads on .rdesk-report[data-state] (found/failed/paused).
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

  test('opens Researchers from the Manage rail and mounts the Field Desk (add tiles, no native select)', async () => {
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
    await expect(view.locator('.rdesk-title')).toContainText('Researchers');
    // A minimal (non-git) seeded vault has no researchers → empty state + the add DOCK (named template
    // tiles, not a dropdown — the redesign's headline change; #65).
    await expect(view.locator('.rdesk-add')).toBeVisible();
    await expect(view.locator('.rdesk-tile')).toHaveCount(4); // web · code · m365 · custom

    // §6 anti-generic guardrail, enforced on the REAL packaged build: the Field Desk uses ZERO native
    // <select> — clearance is a custom rung ladder, schedule/autonomy are segmented buttons, kind is
    // tiles. (Asserted in happy-dom too; this proves it survives the production bundle.)
    await expect(view.locator('select')).toHaveCount(0);
  });
});
