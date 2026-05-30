// e2e smoke (SPEC-0012 TEST-4; SPEC-0009 SETUP-1). Two complementary checks:
//
//  1. UI smoke — Playwright drives the production-built app bundle (`.vite/build/main.js`,
//     real main + preload + renderer) with a clean userData dir, and asserts the first-run
//     Setup wizard renders (SETUP-1). Playwright attaches here because the built bundle is
//     not fuse-locked.
//  2. Packaged boot-survival — the fully-packaged, fused binary can't be driven by Playwright
//     (fuses disable Node inspect / RunAsNode), so we instead spawn it with a clean userData
//     dir and assert it boots and stays up without crashing. This is the check that would
//     have caught the `simple-git` asar-bundling bug (a missing bundled dep crashes on boot).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry, packagedExecutable } from './packagedApp';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
}

test.describe('SETUP-1 — first-run boot', () => {
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

  test('SETUP-1: built app boots and shows the first-run Setup UI', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshUserDataDir();
    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const heading = window.locator('#app h1');
    await expect(heading).toBeVisible({ timeout: 15_000 });
    // Clean userData ⇒ no configured vault ⇒ Setup wizard (SETUP-1 / SETUP-6).
    await expect(heading).toHaveText('Set up your Knowledge Base');
  });
});

test('TEST-4: packaged app boots without crashing (asar/dep-bundling smoke)', async () => {
  const exe = packagedExecutable();
  expect(exe, 'packaged app not found — run `npm run package` first').toBeTruthy();

  const userDataDir = freshUserDataDir();
  const child = spawn(exe as string, [`--user-data-dir=${userDataDir}`], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  // If a bundled dep is missing, the main process throws and the app exits early.
  const earlyExit = await new Promise<{ code: number | null } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000); // survived 6s ⇒ booted OK
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

  try {
    expect(earlyExit, `packaged app exited during boot (code ${earlyExit?.code}). stderr:\n${stderr}`).toBeNull();
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
