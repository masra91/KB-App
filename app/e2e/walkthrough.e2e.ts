// Live-run walkthrough harness — the CORRECTIVE SWARM gate-of-record (06-28).
//
// WHY THIS EXISTS: the packaged build shipped broken (Explore/Health fail-to-load, screens
// recolored-not-redesigned) because the visual gates were STATIC CSS audits — nobody drove the
// real .app. The new rule: "view done" = a LIVE packaged-app walkthrough that DL **and** QD each
// sign. This harness makes that a repeatable command.
//
// WHAT IT DOES: launches the REAL built bundle on a SEEDED, populated, git-backed vault (so the
// data-views render genuine content, not empty states), navigates EVERY rail view, and writes a
// full-window PNG of each in BOTH themes to `e2e/walkthrough-shots/`. DL-2 (and I, and PM) then Read
// the PNGs and judge each surface against the prototype. It does NOT assert pixel baselines — it
// captures the TRUTH of each view (including a stuck "busy"/"couldn't load" state, which is exactly
// what the static gate missed). The only hard assertion is that the app booted to the shell.
//
// Dark is the v2 `[data-theme="dark"]` opt-in token layer (#445) — NOT prefers-color-scheme — so we
// inject the attribute via page.evaluate (emulateMedia would do nothing). Run it with:
//   ALLOW_LOCAL_E2E=1 npm run walkthrough          (from app/, packages first if needed)
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';
import { seedWalkthroughVault } from './seededVault';
import { NAV_VIEWS } from '../src/shell/views';

const SHOTS_DIR = path.join(__dirname, 'walkthrough-shots');

function resetShotsDir(): void {
  fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

function rmBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

test.describe('LIVE WALKTHROUGH — every view, both themes, on a seeded vault (gate-of-record)', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string | null = null;
  let vault: string | null = null;

  test.afterEach(async () => {
    await app?.close();
    app = null;
    if (userDataDir) rmBestEffort(userDataDir);
    if (vault) rmBestEffort(vault);
    userDataDir = vault = null;
  });

  test('captures all views in light + dark for DL/QD sign-off', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    const seeded = seedWalkthroughVault();
    userDataDir = seeded.userDataDir;
    vault = seeded.vault;
    resetShotsDir();

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Configured + populated vault ⇒ the shell (not Setup). This is the one hard gate: the app booted.
    await expect(page.locator('.sidebar, #app .shell, .nav-item').first()).toBeVisible({ timeout: 20_000 });

    const setTheme = async (theme: 'light' | 'dark'): Promise<void> => {
      // Dark = the v2 [data-theme="dark"] opt-in token layer (#445), NOT prefers-color-scheme — set
      // it on <html> where it persists across nav clicks (no reload). Light = default vellum (absent).
      await page.evaluate((t) => {
        if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
    };

    // Capture every rail view in one theme: click its nav item, let it settle (so a stuck busy/error
    // state is captured as-is — that's the whole point), then a full-window PNG.
    const captureRailViews = async (theme: 'light' | 'dark'): Promise<string[]> => {
      const written: string[] = [];
      for (const v of NAV_VIEWS) {
        const nav = page.locator(`.nav-item[data-view="${v.id}"]`);
        if ((await nav.count()) === 0) continue; // not a rail entry in this build — skip, don't fail
        await nav.click();
        // Wait for the view container to mount, then a fixed settle for async (IPC) content to paint.
        await page.locator(`.view[data-view="${v.id}"]`).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${v.id}-${theme}.png`) });
        written.push(`${v.id}-${theme}.png`);
      }
      return written;
    };

    // Rail views first, both themes — toggling data-theme keeps the same shell DOM (no nav-item teardown).
    await setTheme('light');
    const light = await captureRailViews('light');
    await setTheme('dark');
    const dark = await captureRailViews('dark');

    // Showcase LAST: the #showcase hash route replaces the shell DOM (nav-items vanish), so it can't be
    // followed by a rail pass without a reload. Capture it terminally in both themes.
    const showcase: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme);
      await page.evaluate(() => {
        window.location.hash = 'showcase';
      });
      await page.locator('.showcase').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS_DIR, `showcase-${theme}.png`) });
      showcase.push(`showcase-${theme}.png`);
    }

    const all = [...light, ...dark, ...showcase];
    fs.writeFileSync(
      path.join(SHOTS_DIR, 'INDEX.md'),
      `# Live walkthrough screenshots\n\n${all.length} shots (${light.length} light + ${dark.length} dark), seeded vault, packaged bundle.\n\n` +
        all.map((f) => `- ${f}`).join('\n') +
        '\n',
    );
    console.log(`[walkthrough] wrote ${all.length} screenshots to ${SHOTS_DIR}`);
    expect(all.length).toBeGreaterThan(0);
  });
});
