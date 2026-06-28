// e2e global setup. Three jobs, in order:
//
//  1. Guard: e2e is CI-only (SPEC-0012 TEST-9 / TEST-4) — launching real Electron windows
//     and packaging is disruptive on a dev machine. Refuse to run unless in CI, with an
//     explicit escape hatch (`ALLOW_LOCAL_E2E=1`) for the rare intentional local debug.
//  2. Freshness guard (CORRECTIVE SWARM gate-of-record): the e2e — especially the live-run
//     `walkthrough` gate — MUST exercise the CHECKED-OUT code, not a stale build. The old logic
//     skipped packaging whenever `.vite` + `out` existed, so checking out a new SHA over a prior
//     build silently gated the OLD bundle (DL-2's "harness-trap", DEV-3 +1). We now stamp the built
//     SHA and only skip when the existing build provably matches HEAD (and `src/` is clean). On a
//     SHA mismatch / dirty src / `E2E_FRESH=1`, we wipe `.vite`+`out` and repackage.
//  3. Ensure build artifacts exist so the smokes run against real bundles. `npm run package`
//     produces both `.vite/build` (the bundle Playwright drives) and `out/` (the packaged binary
//     for the boot-survival check).
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { builtMainEntry, packagedExecutable } from './packagedApp';

const APP_ROOT = path.resolve(__dirname, '..');
// Marker lives at the app root (NOT under .vite/out, which we wipe + which the vite build may clean),
// so it's a stable record of "which SHA the current build was produced from". Gitignored.
const SHA_MARKER = path.join(APP_ROOT, '.e2e-built-sha');

/** The checked-out commit, or null when not in a git repo (don't let the guard wedge a non-repo run). */
function headSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** True when bundled source (`app/src`) has uncommitted changes — HEAD alone wouldn't reflect them,
 *  so a build stamped at HEAD could still be stale against the working tree. */
function srcDirty(): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: APP_ROOT, encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

function readMarker(): string | null {
  try {
    return fs.readFileSync(SHA_MARKER, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function wipeArtifacts(): void {
  for (const dir of ['.vite', 'out']) {
    fs.rmSync(path.join(APP_ROOT, dir), { recursive: true, force: true });
  }
}

export default function globalSetup(): void {
  if (!process.env.CI && !process.env.ALLOW_LOCAL_E2E) {
    throw new Error(
      'e2e is CI-only (SPEC-0012 TEST-9): it launches Electron windows and packages the app, ' +
        'which is disruptive locally. It runs in GitHub Actions (opt-in `e2e` label / dispatch). ' +
        'To run it locally anyway for debugging, set ALLOW_LOCAL_E2E=1.',
    );
  }

  const forceFresh = !!(process.env.E2E_FRESH || process.env.WALKTHROUGH_FRESH);
  const onCI = !!process.env.CI;
  const haveArtifacts = !!(builtMainEntry() && packagedExecutable());
  const sha = headSha();
  const builtSha = readMarker();

  // CI packages the app in a dedicated step immediately before this runs (ci.yml: "Package the app"
  // → "Playwright e2e"), so artifacts on CI are always fresh for the checked-out SHA — skip without a
  // marker, and never double-package at the 10× macOS rate.
  if (!forceFresh && onCI && haveArtifacts) return;

  // Local: skip ONLY when the build is provably current — a marker that matches HEAD and a clean `src`.
  // No marker / stale marker / dirty src ⇒ (re)build, so a local live-run gate never validates a stale
  // bundle (DL-2's harness-trap). Same-SHA re-runs still skip → fast iteration is preserved.
  if (!forceFresh && !onCI && haveArtifacts && builtSha !== null && builtSha === sha && !srcDirty()) return;

  const staleBuild = builtSha !== null && builtSha !== sha;
  if (forceFresh || staleBuild) {
    console.log(`[e2e] Clean rebuild — ${forceFresh ? 'E2E_FRESH set' : `built SHA ${builtSha?.slice(0, 8)} ≠ HEAD ${sha?.slice(0, 8)}`}. Wiping .vite + out…`);
    wipeArtifacts();
  } else if (!haveArtifacts) {
    console.log('[e2e] Build artifacts missing — running `npm run package` (this can take a few minutes)…');
  } else {
    console.log('[e2e] Build not stamped to HEAD (or src dirty) — repackaging so e2e exercises the checked-out code…');
  }
  execSync('npm run package', { stdio: 'inherit' });
  // Stamp the build with the SHA it was produced from (best-effort; skipped outside a repo).
  if (sha) fs.writeFileSync(SHA_MARKER, sha + '\n');
}
