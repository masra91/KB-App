// Shared git-availability signal for tests (SPEC-0012 TEST — git-less-runner convention).
//
// Many domain tests exercise real git against a throwaway temp vault (TEST-18). On a runner
// WITHOUT git on PATH they must skip rather than error — hence `describe.skipIf(!gitAvailable)`.
// This is the ONE canonical definition; test files should import `gitAvailable` from here instead
// of re-declaring their own `gitInstalledSync()` (it was duplicated across ~10 files).
//
// ⚠️ Signal for CI (SPEC-0012): a `skipIf(!gitAvailable)` suite SKIPS silently on a git-less
// runner — a green run there does NOT mean the git-backed behavior was verified. CI MUST run the
// unit job on a git-equipped runner so these suites actually execute; otherwise the skip masks
// red as green. Treat "git tests skipped" as a red flag in any environment expected to have git.
import { execFileSync } from 'node:child_process';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when system git is on PATH. Gate git-backed suites with `describe.skipIf(!gitAvailable)`. */
export const gitAvailable = gitInstalledSync();
