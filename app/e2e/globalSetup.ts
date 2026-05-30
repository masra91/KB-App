// e2e global setup. Two jobs, in order:
//
//  1. Guard: e2e is CI-only (SPEC-0012 TEST-9 / TEST-4) — launching real Electron windows
//     and packaging is disruptive on a dev machine. Refuse to run unless in CI, with an
//     explicit escape hatch (`ALLOW_LOCAL_E2E=1`) for the rare intentional local debug.
//  2. Ensure build artifacts exist so the smokes run against real bundles. `npm run package`
//     produces both `.vite/build` (the bundle Playwright drives) and `out/` (the packaged
//     binary for the boot-survival check). Slow, so skip when both are present.
import { execSync } from 'node:child_process';
import { builtMainEntry, packagedExecutable } from './packagedApp';

export default function globalSetup(): void {
  if (!process.env.CI && !process.env.ALLOW_LOCAL_E2E) {
    throw new Error(
      'e2e is CI-only (SPEC-0012 TEST-9): it launches Electron windows and packages the app, ' +
        'which is disruptive locally. It runs in GitHub Actions (opt-in `e2e` label / dispatch). ' +
        'To run it locally anyway for debugging, set ALLOW_LOCAL_E2E=1.',
    );
  }

  if (builtMainEntry() && packagedExecutable()) return;
  console.log('[e2e] Build artifacts missing — running `npm run package` (this can take a few minutes)…');
  execSync('npm run package', { stdio: 'inherit' });
}
