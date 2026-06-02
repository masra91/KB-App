// e2e packaged-recall smoke — the regression guard for BUG #65 (SPEC-0012 TEST-21).
//
// BUG #65: in the packaged app, recall did `new CopilotClient()` with NO cliPath, so the SDK
// searched for a *bundled* `@github/copilot` package — unresolvable in the asar — and recall
// returned ungrounded with "Could not find @github/copilot package. Searched N paths." The fix
// (#75) resolves the user's BYOA `copilot` on PATH and connects to it:
//   resolveExecutable('copilot')  →  CopilotClient({ connection: RuntimeConnection.forStdio({ path }) }).
// That break is invisible to typecheck/lint/unit and is NOT a boot crash (the boot-survival smoke
// won't catch it). This smoke exercises the real recall wiring (NO KB_ASK_E2E_STUB) and asserts:
//   • POSITIVE: the app actually RESOLVED + SPAWNED the BYOA copilot (the forStdio path ran) —
//     proven by the fake copilot touching a marker file when invoked;
//   • NEGATIVE (the regression catch): the result does NOT contain the bundled-package-search
//     signature — i.e. it never fell back to the bare-ctor `@github/copilot` lookup #65 produced.
//
// Deterministic + CI-safe (no real LLM, no API key): a FAKE `copilot` on PATH exits non-zero
// immediately, so the SDK connection fails fast and recall returns an honest ungrounded result.
// Like the rest of e2e it drives the production-built bundle (Playwright can't attach to the fused
// packaged binary — see smoke.e2e.ts / SPEC-0012 §2) and is CI-only (globalSetup guard, TEST-9).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';
import type { AskResult } from '../src/kb/recall';

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

/** A configured (non-onboarding) KB so the renderer mounts the shell + `kb:ask` runs real recall. */
function seedConfiguredKb(userDataDir: string): string {
  const vault = freshDir('kb-e2e-recall-vault-');
  fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.kb', 'config.json'),
    JSON.stringify({ schemaVersion: 1, id: 'e2e-recall-kb', name: 'E2E Recall KB', createdAt: '2026-06-02T00:00:00.000Z' }, null, 2),
  );
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');
  return vault;
}

/**
 * Plant a FAKE BYOA `copilot` the app will resolve + spawn instead of any real one. When invoked it
 * (1) touches `<binDir>/spawned` — proof the resolved CLI actually ran (the #65 forStdio path) —
 * then (2) exits non-zero so the SDK connection fails fast (no real LLM call). Returns the bin dir,
 * the marker path, and a fake login shell.
 *
 * The fake shell is the determinism lever: `ensurePath` (STACK-9) asks `$SHELL` for the login PATH
 * and prepends it AHEAD of its fixed fallback dirs (`/opt/homebrew/bin`, …). A real `copilot` may
 * live in those fallbacks on a dev machine, so we point `$SHELL` at a stub that advertises ONLY our
 * bin dir — guaranteeing our fake resolves first regardless of host. (CI runners have no real
 * copilot, so this is belt-and-suspenders there; it's what makes a local `ALLOW_LOCAL_E2E=1` run
 * honest on a machine that has copilot installed.)
 */
function plantFakeCopilot(): { binDir: string; marker: string; fakeShell: string } {
  const binDir = freshDir('kb-e2e-fakebin-');
  const marker = path.join(binDir, 'spawned');

  // Unix stub. `$(dirname "$0")` is binDir (the SDK invokes the resolved absolute path), so the
  // marker is found without relying on env inheritance into the spawned process.
  const unix = `#!/bin/sh\n: > "$(dirname "$0")/spawned"\necho "KB65_SMOKE_COPILOT_SPAWNED" >&2\nexit 1\n`;
  fs.writeFileSync(path.join(binDir, 'copilot'), unix, { mode: 0o755 });
  // Windows stub (resolveExecutable probes copilot.cmd). %~dp0 is binDir (with trailing sep).
  const win = `@echo off\r\ntype nul > "%~dp0spawned"\r\necho KB65_SMOKE_COPILOT_SPAWNED 1>&2\r\nexit /b 1\r\n`;
  fs.writeFileSync(path.join(binDir, 'copilot.cmd'), win);

  // Fake login shell: ignores its args and prints the PATH marker `ensurePath`/loginShellPath parses.
  const fakeShell = path.join(binDir, 'fake-login-shell.sh');
  fs.writeFileSync(fakeShell, `#!/bin/sh\nprintf '__KBPATH__%s\\n' "${binDir}"\n`, { mode: 0o755 });

  return { binDir, marker, fakeShell };
}

test.describe('TEST-21 / BUG #65 — packaged recall resolves + spawns the BYOA copilot (not the asar bundled lookup)', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string | null = null;
  let vaultDir: string | null = null;
  let binDir: string | null = null;

  test.afterEach(async () => {
    await app?.close();
    app = null;
    for (const d of [vaultDir, userDataDir, binDir]) if (d) rmDirBestEffort(d);
    vaultDir = userDataDir = binDir = null;
  });

  test('recall takes the resolveExecutable→forStdio path; no "@github/copilot" bundled-search fallback', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshDir('kb-e2e-recall-');
    vaultDir = seedConfiguredKb(userDataDir);
    const fake = plantFakeCopilot();
    binDir = fake.binDir;

    app = await electron.launch({
      args: [main as string, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        // Real recall (NOT the deterministic stub ask.e2e.ts uses).
        KB_ASK_E2E_STUB: '',
        // Our fake bin first; the fake login shell makes ensurePath prepend it ahead of its fallbacks.
        PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        SHELL: fake.fakeShell,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // The contextBridge `kbApi` is the recall entry point; assert on the structured AskResult
    // directly (this smoke targets recall wiring, not the Ask UI — that's ask.e2e.ts).
    await window.waitForFunction(() => typeof (window as unknown as { kbApi?: unknown }).kbApi !== 'undefined', null, {
      timeout: 15_000,
    });
    const result = (await window.evaluate(
      (q) => (window as unknown as { kbApi: { ask: (r: { question: string }) => Promise<AskResult> } }).kbApi.ask({ question: q }),
      'Who was Ada Lovelace?',
    )) as AskResult;

    // POSITIVE — the app resolved the BYOA copilot and SPAWNED it (the #65 forStdio path ran).
    // Skipped on Windows: the `.cmd` stub's exec contract under the SDK's stdio spawn is less
    // certain, and the NEGATIVE regression guard below (which runs everywhere) is the hard check.
    if (process.platform !== 'win32') {
      expect(fs.existsSync(fake.marker), 'the resolved copilot was never spawned — recall did not take the forStdio path').toBe(true);
    }

    // The honest failure contract: ungrounded, structured, no fabrication, no crash.
    expect(result, 'kb:ask returned no structured AskResult').toBeTruthy();
    expect(result.grounded).toBe(false);
    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);

    // NEGATIVE — the #65 regression guard: never the bare-ctor bundled-package search.
    const blob = JSON.stringify(result).toLowerCase();
    expect(blob, 'recall fell back to the bundled @github/copilot search — BUG #65 has regressed').not.toContain('@github/copilot');
    expect(blob).not.toMatch(/could not find .*copilot.*package/);
  });
});
