// OPT-IN behavioral eval for DECOMP-17 granularity (KB-QD's pass-bar). NOT part of CI: it needs a
// real BYOA `copilot` + network and is non-deterministic, so — like the packaged e2e — it runs only
// on demand. Double-gated: it lives under `eval/` (the vitest unit config's `include` is `src/**`,
// so it's never collected by the normal suite) AND it skips unless `KB_EVAL=1`.
//
//   Run:  cd app && KB_EVAL=1 npm run eval:enrich
//
// It runs decompose/v2 over each golden fixture N times, scores each decision with the pure
// `enrichEval` logic, and asserts the HARD set-assertions (recall + precision) held in EVERY run;
// node counts are reported as median + range (the loose over-extraction bound is surfaced, not
// hard-failed). The deterministic CI gate stays the prompt-policy (decomposeAgent.test.ts) +
// dedup-core (claimDedup.test.ts) + this module's scoring logic (enrichEval.test.ts).
import { describe, it, expect } from 'vitest';
import { makeDecomposeDecider, type SourceInput } from '../src/kb/decomposeAgent';
import { evaluateGranularity, aggregateRuns, formatAggregate, type GranularityCheck } from '../src/kb/enrichEval';
import { GRANULARITY_FIXTURES } from './granularityFixtures';

const ENABLED = process.env.KB_EVAL === '1';
const RUNS = Number(process.env.KB_EVAL_RUNS ?? '3'); // KB-QD: N≥3 for robustness to non-determinism
const PER_FIXTURE_TIMEOUT_MS = 10 * 60_000; // RUNS × a single decompose (copilot is slow)

describe.skipIf(!ENABLED)('DECOMP-17 granularity eval (opt-in; real copilot)', () => {
  const decide = makeDecomposeDecider(); // production decider — shells to `copilot -p`

  for (const fixture of GRANULARITY_FIXTURES) {
    it(
      `${fixture.name}: genuine entities are nodes, descriptors are not (≥${RUNS} runs)`,
      async () => {
        const checks: GranularityCheck[] = [];
        for (let i = 0; i < RUNS; i++) {
          const input: SourceInput = { sourceId: `eval-${fixture.name}-${i}`, kind: 'text', text: fixture.sourceText };
          const decision = await decide(input);
          checks.push(evaluateGranularity(decision, fixture));
        }
        const agg = aggregateRuns(fixture.name, checks);
        console.log(formatAggregate(agg)); // the eval's whole purpose is to REPORT the behavior
        expect(agg.everMissingMustBe, `recall: expected entities missed in some run`).toEqual([]);
        expect(agg.everPresentMustNot, `precision: descriptors/roles leaked in as nodes`).toEqual([]);
      },
      PER_FIXTURE_TIMEOUT_MS,
    );
  }
});
