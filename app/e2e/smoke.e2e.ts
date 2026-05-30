// Packaged-app boot smoke (SPEC-0012 TEST-4; SPEC-0009 SETUP-1/SETUP-6).
// Launches the real packaged Electron app with a clean userData dir (guaranteeing the
// first-run state) and asserts the Setup wizard renders. A booting, rendering window is
// the smoke that would have caught the simple-git asar-bundling bug.
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packagedExecutable } from './packagedApp';

let app: ElectronApplication | null = null;
let userDataDir: string | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
  if (userDataDir) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = null;
  }
});

test('SETUP-1: packaged app boots and shows the first-run Setup UI', async () => {
  const exe = packagedExecutable();
  expect(exe, 'packaged app not found — run `npm run package` first').toBeTruthy();

  // Force a clean userData so the app has no configured vault → first-run (SETUP-6).
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
  app = await electron.launch({ executablePath: exe as string, args: [`--user-data-dir=${userDataDir}`] });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // The renderer actually rendered (packaged smoke — TEST-4) ...
  const heading = window.locator('#app h1');
  await expect(heading).toBeVisible({ timeout: 15_000 });
  // ... and with no configured vault it is the Setup wizard (SETUP-1).
  await expect(heading).toHaveText('Set up your Knowledge Base');
});
