// e2e happy-path for SPEC-0026 Ask & Recall slice 2 (ASK-1 surface). Drives the production-built
// app: a pre-configured KB so it boots to the shell, then Ask → type a question → a grounded,
// cited answer renders. The live Copilot SDK/CLI isn't available/auth'd in CI, so the main process
// runs with KB_ASK_E2E_STUB=1, which short-circuits the `kb:ask` handler to a deterministic recall
// result — this test honestly exercises the UI → IPC → render path (the live SDK round-trip stays
// e2e/manual). e2e is CI-only (SPEC-0012 TEST-9).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-ask-'));
}

function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

/** Seed a configured (non-onboarding) KB: a vault with `.kb/config.json` + the app-level config
 *  pointing at it, so the renderer mounts the shell instead of the Setup wizard (SETUP-6). */
function seedConfiguredKb(userDataDir: string): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-vault-'));
  fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.kb', 'config.json'),
    JSON.stringify({ schemaVersion: 1, id: 'e2e-kb', name: 'E2E KB', createdAt: '2026-06-02T00:00:00.000Z' }, null, 2),
  );
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');
  return vault;
}

test.describe('ASK-1 — ask → grounded cited answer (stubbed recall)', () => {
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

  test('renders a grounded answer with a citation from the Ask view', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshUserDataDir();
    vaultDir = seedConfiguredKb(userDataDir);

    app = await electron.launch({
      args: [main as string, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, KB_ASK_E2E_STUB: '1' },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Configured KB ⇒ shell (not Setup). Navigate to Ask.
    const askNav = window.locator('.nav-item[data-view="ask"]');
    await expect(askNav).toBeVisible({ timeout: 15_000 });
    await askNav.click();

    // Ask a question.
    const input = window.locator('#askInput');
    await expect(input).toBeVisible();
    await input.fill('Who was Ada Lovelace?');
    await window.locator('#askBtn').click();

    // A grounded answer with its citation renders.
    const transcript = window.locator('.ask-transcript');
    await expect(transcript).toContainText('first computer programmer', { timeout: 15_000 });
    await expect(window.locator('.ask-citations')).toContainText('claims/person/ada-lovelace.md');
    await expect(transcript).toContainText('Who was Ada Lovelace?'); // the question echoes back
  });
});
