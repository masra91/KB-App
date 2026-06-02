// Stage CLI resolution — the BYOA `copilot` reaches the pipeline STAGES in a GUI-launched /
// packaged app (verification of the dogfood #6 concern; SPEC-0030 / STACK-9 / BUG #65 sibling).
//
// BUG #65 was about RECALL: the `@github/copilot-sdk` did `new CopilotClient()` with no cliPath,
// so it searched for a *bundled* `@github/copilot` npm package in the asar (ignoring PATH) and
// failed. The fix points the SDK at the resolved CLI path.
//
// The STAGES (decompose/connect/claims/archivist) take a DIFFERENT path: their `defaultRunner`
// does `execFile('copilot', ['-p', …])` — a bare-name spawn that inherits `process.env` (no env
// override) and resolves `copilot` via PATH (execvp), NOT via any bundled package. So they are
// NOT a #65-class asar bug. Their ONLY requirement is that `process.env.PATH` actually contains
// the BYOA `copilot` — which a GUI/packaged launch gets a stripped version of, recovered at boot
// by `ensurePath()` (STACK-9, main.ts). #79 already proves `ensurePath` works in the packaged
// build (recall resolved the BYOA copilot through it). This test closes the loop for the stages:
// on a GUI-stripped PATH, after `ensurePath()`, the REAL stage runner's `copilot -p` resolves and
// spawns the BYOA CLI (no `spawn ENOENT`). Deterministic — a fake `copilot` on PATH, no live LLM.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensurePath } from '../main/resolvePath';
import { makeDecomposeDecider } from './decomposeAgent';

function gitInstalledSync(): boolean {
  // (unused — only here to keep the skip pattern uniform if needed)
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
void gitInstalledSync;

// POSIX-only: the fake CLI + fake login shell are `/bin/sh` scripts, and the unit/`quick` CI job
// runs on Linux (ci.yml). ensurePath's login-shell recovery is a no-op on win32 anyway (STACK-9).
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('stage CLI resolution — copilot -p resolves the BYOA CLI after ensurePath (dogfood #6)', () => {
  let binDir: string;
  let savedPath: string | undefined;
  let savedShell: string | undefined;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-stagecli-'));
    savedPath = process.env.PATH;
    savedShell = process.env.SHELL;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it('a GUI-stripped PATH + boot ensurePath lets the real Decompose runner spawn the BYOA copilot', async () => {
    // Fake BYOA copilot: answers `--version` (so detectCopilot passes) and the `-p` call (so the
    // stage runner spawns it); touches a marker when invoked → proof it was resolved + spawned.
    const marker = path.join(binDir, 'stage-spawned');
    const fake = [
      '#!/bin/sh',
      `: > "${marker}"`,
      'case "$1" in',
      '  --version) echo "copilot 1.0.0-fake"; exit 0 ;;',
      'esac',
      // the `-p` invocation: emit a minimal valid (empty) decompose result, exit 0.
      'echo \'{"entities": []}\'',
      'exit 0',
    ].join('\n');
    await fs.writeFile(path.join(binDir, 'copilot'), fake + '\n', { mode: 0o755 });

    // Fake login shell that advertises ONLY our binDir, so `ensurePath` prepends it ahead of its
    // fixed fallback dirs (`/opt/homebrew/bin`, …) — making our fake win even on a dev box that has
    // a real copilot installed. (Same determinism lever as the #79 recall smoke.)
    const fakeShell = path.join(binDir, 'login-shell.sh');
    await fs.writeFile(fakeShell, `#!/bin/sh\nprintf '__KBPATH__%s\\n' "${binDir}"\n`, { mode: 0o755 });

    // Simulate a GUI/packaged launch: a stripped PATH with NO copilot, then recover via ensurePath.
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = fakeShell;
    await ensurePath(); // mutates process.env.PATH — exactly what main.ts does at boot

    // Drive the REAL Decompose decider (no injected runner) → detectCopilot + `copilot -p`, both
    // bare-name execFile spawns inheriting process.env.PATH.
    const decider = makeDecomposeDecider();
    let threw: unknown = null;
    try {
      await decider({ sourceId: '01TESTSOURCE', text: 'Ada Lovelace worked on the Analytical Engine.' } as Parameters<typeof decider>[0]);
    } catch (e) {
      threw = e; // a parse/shape error is irrelevant here — we only care that the CLI RESOLVED
    }

    // The decisive proof: the BYOA copilot was resolved + spawned (NOT a #65-class miss).
    expect(await fileExists(marker), 'the stage runner never spawned copilot — it failed to resolve on PATH').toBe(true);

    // And it was NOT an unresolved-binary failure (spawn ENOENT / command not found).
    if (threw instanceof Error) {
      expect(threw.message).not.toMatch(/ENOENT|not found|command not found/i);
    }
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
