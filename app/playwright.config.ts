import { defineConfig } from '@playwright/test';

// SPEC-0012 TEST-4 / TEST-11. e2e drives the REAL packaged Electron app. This layer is
// CI-only — explicitly excluded from the local quick suite (/validate, TEST-9). Phased
// rollout: this scaffold + boot smoke is the starting point; broader flows and the full
// macOS+Windows matrix grow from here.
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  // Ensures the app is packaged before the smoke runs (so it exercises the real artifact).
  globalSetup: './e2e/globalSetup.ts',
});
