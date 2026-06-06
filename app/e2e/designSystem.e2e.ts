// WS2 / DESIGN-SYS — the one-time visual SNAPSHOT guard for the four canonical design-system
// primitives (Button · SegmentedControl · ConfirmInline · EditableField), per the Principal HYBRID
// visual/CSS gate (SPEC-0033 §6 / DESIGN-9): a WS2 blessed primitive gets an e2e visual-snapshot
// authored ONCE against its canonical form; later migration PRs (Jobs/Researchers/Reviews → primitives)
// reuse THIS snapshot instead of per-PR regression boilerplate.
//
// It boots the REAL packaged app and opens the Researchers "Field Desk" — the surface that composes all
// four primitives at once (post #225/#226): the clearance ladder + schedule/autonomy SegmentedControls,
// the standing-orders + reads/pass + timeout EditableFields, the Run/template Buttons, and (on Run) the
// ConfirmInline consequence gate. We seed ONE disabled, never-run researcher so the strip renders
// deterministically (report = "never run", no timestamps) — a stable baseline.
//
// BASELINE: platform-suffixed + generated in the linux CI env (`test:e2e --update-snapshots` on the
// ubuntu runner), NOT locally on macOS — a darwin baseline would never match CI's linux render. This
// spec is authored here; the linux-CI run generates + commits the `*-linux.png` reference and validates
// that the seeded strip renders. CI-only / opt-in (SPEC-0012 TEST-9), like the other e2e.
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';
import { writeResearcherRegistry } from '../src/kb/researcherRegistry';
import type { ResearcherConfig } from '../src/kb/researchers';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-designsys-'));
}
function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

/** A disabled, never-run researcher → its strip renders every primitive in a deterministic resting
 *  state (no last-run timestamp, "Paused" eligibility, the clearance ladder lit on its tier). */
const SHOWCASE: ResearcherConfig = {
  id: 'design-system-showcase',
  template: 'web',
  prompt: 'Canonical primitives showcase for the WS2 visual snapshot.',
  egressTier: 'public-web',
  scope: 'global',
  budget: { maxToolCalls: 15, maxDepth: 2 },
  schedule: 'off',
  posture: 'guarded',
  enabled: false,
};

async function seedShowcaseKb(userDataDir: string): Promise<string> {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-designsys-vault-'));
  fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.kb', 'config.json'),
    JSON.stringify({ schemaVersion: 1, id: 'e2e-designsys-kb', name: 'E2E Design System KB', createdAt: '2026-06-06T00:00:00.000Z' }, null, 2),
  );
  await writeResearcherRegistry(vault, [SHOWCASE]); // one strip → all four primitives, deterministic
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');
  return vault;
}

test.describe('DESIGN-SYS — visual snapshot of the four canonical primitives (WS2 HYBRID guard)', () => {
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

  test('the Researchers strip renders Button · SegmentedControl · EditableField (resting) and ConfirmInline (on Run)', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();
    userDataDir = freshUserDataDir();
    vaultDir = await seedShowcaseKb(userDataDir);

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await window.locator('.nav-item[data-view="researchers"]').click();
    const strip = window.locator('.rdesk-strip[data-id="design-system-showcase"]');
    await expect(strip).toBeVisible({ timeout: 15_000 });
    // Resting strip: clearance ladder + schedule/autonomy SegmentedControls, standing-orders +
    // reads/pass + timeout EditableFields, the Run Button. (Deterministic — disabled, never-run.)
    await expect(strip.locator('.viz-seg')).toHaveCount(3); // ladder + schedule + autonomy
    await expect(strip.locator('.viz-field__input')).not.toHaveCount(0);
    await expect(strip.locator('.viz-btn.researcher-run')).toBeVisible();

    // Canonical resting snapshot — the three always-visible primitives in "The Line" language.
    await expect(strip).toHaveScreenshot('design-system-primitives-resting.png');

    // ConfirmInline is the consequence gate — hidden at rest; Run reveals it (no dispatch happens until
    // the confirm is accepted, so this needs no git-backed pipeline). Snapshot the revealed primitive.
    await strip.locator('.viz-btn.researcher-run').click();
    const confirm = strip.locator('.viz-confirm.researcher-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveScreenshot('design-system-confirm-inline.png');
  });
});
