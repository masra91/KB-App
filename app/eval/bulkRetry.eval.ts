// SPEC-0049 HEAL-7 — the opt-in bulk-retry RUN. Re-runs a vault's set-aside sources (the dogfood vault's
// ~203, accumulated from harness brittleness) through the REAL decompose→connect→claims drain on the
// resolved model + DEV-2's self-repair, and reports the residual toss-rate (the SPEC-0049 success measure
// → ~0). NOT part of CI: it drives a real BYOA `copilot` over a real vault and is non-deterministic, so —
// like the other evals — it's double-gated: it lives under `eval/` (the unit config's `include` is
// `src/**`) AND skips unless KB_EVAL=1. It additionally needs the target vault via KB_EVAL_RETRY_VAULT.
//
//   Canonical 203-run (after DEV-2's HEAL-1/2 self-repair merges):
//     cd app && KB_EVAL=1 \
//       KB_EVAL_RETRY_VAULT=/path/to/dogfood-vault \
//       KB_COPILOT_MODEL=claude-opus-4.8 \
//       npm run eval -- bulkRetry
//
// Safety: runs on a throwaway COPY of the vault by default (a measurement never mutates the real vault).
// Set KB_EVAL_RETRY_INPLACE=1 to actually remediate the live vault in place.
//
// The deterministic CI guard for this harness's logic (scanner / re-enqueue / report math) is
// runner/bulkRetry.test.ts; this file is the live instrument that produces the residual number.
import { describe, it, expect } from 'vitest';
import { runBulkRetry, formatBulkRetryReport } from './runner/bulkRetry';

const ENABLED = process.env.KB_EVAL === '1';
const VAULT = process.env.KB_EVAL_RETRY_VAULT;
const IN_PLACE = process.env.KB_EVAL_RETRY_INPLACE === '1';
const TIMEOUT_MS = 60 * 60_000; // re-decomposing hundreds of sources over real copilot is slow

describe.skipIf(!ENABLED || !VAULT)('SPEC-0049 HEAL-7 — bulk-retry the set-aside sources (opt-in; real copilot)', () => {
  it(
    'partial-replay re-enqueues every set-aside source, drains it on the resolved model, and reports the residual toss-rate',
    async () => {
      const report = await runBulkRetry({
        vaultPath: VAULT as string,
        inPlace: IN_PLACE,
        onSnapshot: (snap) =>
          console.log(`\n[bulk-retry] post-drain vault: entities=${snap.entities.length} claims=${snap.claims.length} sources=${snap.sources.length}`),
      });
      console.log('\n' + formatBulkRetryReport(report) + '\n');

      // Sanity, not a quality gate (the residual number is the deliverable; quality is the report, read
      // by a human / posted to #control). We re-enqueued exactly the before-population and the residual
      // can never exceed it.
      expect(report.reEnqueued).toBe(report.beforeSetAside);
      expect(report.residualSetAside).toBeLessThanOrEqual(report.beforeSetAside);
      expect(report.converged + report.residualSetAside).toBe(report.beforeSetAside);
    },
    TIMEOUT_MS,
  );
});
