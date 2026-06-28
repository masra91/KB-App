// SPEC-0034 MACOS-2/5 — the protected-folder smoke (the verify-by-running proof that the TCC grant
// propagates to spawned `git` subprocesses on a signed build, so a vault in a macOS-protected folder
// works end-to-end). #56.
//
// WHY THIS IS CERT-GATED + NOT CI: TCC subprocess-propagation can only be exercised on a *signed*
// build (stable identity → the grant persists + propagates to children) with the OS-level Files-and-
// Folders permission — none of which exists in CI or on a non-cert dev machine. So this is a
// RELEASE-GATE smoke (run on the signed build before any notarized release, per MACOS-8), skip-guarded
// to `darwin && KB_SIGNED_E2E=1`. It runs only in a cert + BYOA env (DEV-2's / the Principal's).
//
// RUN RECIPE (MACOS-9):
//   1. Build the SIGNED package (stable signing identity present in the keychain):
//        KB_OSX_SIGN=1 npm run package         # produces out/Vellum-darwin-*/Vellum.app, hardened+signed
//   2. Run this smoke against it:
//        KB_SIGNED_E2E=1 ALLOW_LOCAL_E2E=1 npx playwright test signedProtectedFolder
//   On first run macOS shows the "Allow access to Documents" prompt (MACOS-7) — click Allow once;
//   the grant then persists by signature (MACOS-3). A green run = MACOS-2/5 proven.
//
// THE CHECK (narrow + deterministic, no copilot — agreed with DEV-2): point the signed app at a fresh
// vault under ~/Documents and let it boot. `startPipeline` → `ensureStagingWorktree` performs the
// FIRST spawned-`git` write into the protected path (a `git worktree add` creating
// <vault>/.kb/cache/worktrees/staging) — *before* any copilot. If the staging worktree appears and the
// vault dev-log shows no `Operation not permitted`, the subprocess inherited the TCC grant (MACOS-5).
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packagedExecutable } from './packagedApp';
import { createKb } from '../src/kb/vault';

const SIGNED = process.platform === 'darwin' && !!process.env.KB_SIGNED_E2E;

test.describe('SPEC-0034 MACOS-2/5 — protected-folder TCC subprocess propagation (signed build)', () => {
  // Cert-gated: only a signed build in a TCC-granted env can exercise this (see header).
  test.skip(!SIGNED, 'cert-gated signed-build smoke — set KB_SIGNED_E2E=1 on a signed (KB_OSX_SIGN=1) macOS build');

  let vaultPath = '';
  let userDataDir = '';
  let child: ChildProcess | null = null;

  test.afterEach(async () => {
    if (child) {
      await new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
        child!.kill();
        setTimeout(() => { try { child!.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
      });
      child = null;
    }
    // Best-effort cleanup — we created these under the user's real ~/Documents + temp.
    for (const dir of [vaultPath, userDataDir]) {
      if (dir) { try { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* OS reaps */ } }
    }
  });

  test('MACOS-5: the signed app provisions the staging worktree (git write) inside a ~/Documents vault — zero "Operation not permitted"', async () => {
    const exe = packagedExecutable();
    expect(exe, 'signed package not found — run `KB_OSX_SIGN=1 npm run package` first').toBeTruthy();

    // A real vault under the macOS-protected ~/Documents (the #56 repro location).
    vaultPath = path.join(os.homedir(), 'Documents', `kb-signed-e2e-${Date.now().toString(36)}`);
    await fs.mkdir(vaultPath, { recursive: true });
    const created = await createKb({ path: vaultPath, name: 'Signed E2E', initGitIfNeeded: true });
    expect(created.ok, `createKb failed: ${created.message}`).toBe(true);

    // Seed app-level config so the booting app adopts this vault (SETUP-6) without the UI.
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-signed-e2e-ud-'));
    await fs.writeFile(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vaultPath }, null, 2) + '\n');

    // Boot the SIGNED packaged binary against that userData → startPipeline → ensureStagingWorktree
    // does the first spawned-git write into the protected vault.
    child = spawn(exe as string, [`--user-data-dir=${userDataDir}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    // Give the pipeline time to provision the staging worktree (a git worktree add).
    const stagingWt = path.join(vaultPath, '.kb', 'cache', 'worktrees', 'staging');
    const deadline = Date.now() + 30_000;
    let provisioned = false;
    while (Date.now() < deadline) {
      if (await fs.access(stagingWt).then(() => true, () => false)) { provisioned = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }

    // The git subprocess write into ~/Documents succeeded ⇒ the TCC grant propagated (MACOS-5).
    expect(provisioned, `staging worktree never appeared at ${stagingWt} — git subprocess write into ~/Documents likely failed. stderr:\n${stderr}`).toBe(true);

    // And the dev-log must carry no permission failure (the #56 silent-break signature).
    const log = await fs.readFile(path.join(vaultPath, '.kb', 'cache', 'logs', 'pipeline.log'), 'utf8').catch(() => '');
    expect(log, 'pipeline.log shows "Operation not permitted" — TCC grant did NOT propagate to the git subprocess').not.toContain('Operation not permitted');
  });
});
