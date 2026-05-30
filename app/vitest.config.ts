/// <reference types="vitest" />
// Vitest config (SPEC-0012 TEST-3). Vite-native runner; node environment for the
// shell-agnostic domain. Component tier (jsdom/happy-dom) is reserved (TEST-5) and not
// configured yet. e2e lives under `e2e/` and is driven by Playwright, not Vitest.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.vite/**', 'dist/**', 'out/**'],
    coverage: {
      provider: 'v8',
      // TEST-12 / ENG-10: gate coverage on the shell-agnostic domain/core only.
      // Main-process glue is Electron-bound (covered by e2e); the renderer/component
      // tier is reserved (TEST-5/13) — neither carries a unit-coverage gate yet.
      include: ['src/kb/**/*.ts'],
      exclude: ['src/kb/**/*.test.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
