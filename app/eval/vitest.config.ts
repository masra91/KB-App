/// <reference types="vitest" />
// Dedicated config for the OPT-IN enrich-quality eval (run via `npm run eval:enrich`). The main
// vitest config's `include` is `src/**/*.test.ts`, so these `eval/**/*.eval.ts` files are never
// collected by the normal CI suite — this config opts them in explicitly. The eval still self-skips
// unless `KB_EVAL=1` (it needs a real BYOA `copilot` + network). Generous timeouts: each case runs
// decompose/v2 N times and copilot is slow.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['eval/**/*.eval.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
