// e2e global setup: ensure a packaged build exists so the smoke exercises the REAL
// packaged artifact (SPEC-0012 TEST-4 — catches asar/dep-bundling failures). Packaging
// is slow, so we skip it when a build is already present.
import { execSync } from 'node:child_process';
import { packagedExecutable } from './packagedApp';

export default function globalSetup(): void {
  if (packagedExecutable()) return;
  console.log('[e2e] No packaged app found — running `npm run package` (this can take a few minutes)…');
  execSync('npm run package', { stdio: 'inherit' });
}
