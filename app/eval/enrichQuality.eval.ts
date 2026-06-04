// OPT-IN behavioral eval for DECOMP-17 granularity AND RESEARCH-17 web-researcher depth (KB-QD's
// pass-bars). NOT part of CI: it needs a real BYOA `copilot` + network and is non-deterministic, so —
// like the packaged e2e — it runs only on demand. Double-gated: it lives under `eval/` (the vitest
// unit config's `include` is `src/**`, so it's never collected by the normal suite) AND it skips
// unless `KB_EVAL=1`.
//
//   Run:  cd app && KB_EVAL=1 npm run eval:enrich
//
// DECOMP-17: runs decompose/v2 over each golden fixture N times, scores each decision with the pure
// `enrichEval` logic, and asserts the HARD set-assertions (recall + precision) held in EVERY run;
// node counts are reported as median + range (the loose over-extraction bound is surfaced, not
// hard-failed).
//
// RESEARCH-17: runs the PRODUCTION web-researcher (the egress-gated live SDK `ResearchFn`) over a
// fact-dense public topic N times and reports `countAttributedFacts` per run, soft-asserting the
// MEDIAN clears the KB-QD-ratified floor (N=5) — a real multi-fact attributed note scores ≥5, a thin
// précis scores ~0. Soft (median over runs) because web research is network-bound + non-deterministic;
// this is opt-in dogfood instrumentation, NOT a CI gate, and runs parallel to (does not gate) the
// packaged e2e. The deterministic CI gate stays the prompt-policy (decomposeAgent.test.ts) + dedup-core
// (claimDedup.test.ts) + the scoring/metric logic (enrichEval.test.ts, researchWebAgent.test.ts).
import { describe, it, expect } from 'vitest';
import { makeDecomposeDecider, type SourceInput } from '../src/kb/decomposeAgent';
import { evaluateGranularity, aggregateRuns, formatAggregate, type GranularityCheck } from '../src/kb/enrichEval';
import { makeWebResearchFn, countAttributedFacts } from '../src/kb/researchWebAgent';
import { DEFAULT_RESEARCHER_BUDGET, type ResearcherConfig, type ResearchRequest } from '../src/kb/researchers';
import { resolveCopilotCliPath } from '../src/main/researchWiring';
import { GRANULARITY_FIXTURES } from './granularityFixtures';

const ENABLED = process.env.KB_EVAL === '1';
const RUNS = Number(process.env.KB_EVAL_RUNS ?? '3'); // KB-QD: N≥3 for robustness to non-determinism
const PER_FIXTURE_TIMEOUT_MS = 10 * 60_000; // RUNS × a single decompose (copilot is slow)
// KB-QD-ratified soft floor for the RESEARCH-17 depth bar: a real multi-fact, source-attributed
// findings-note scores ≥5 attributed facts; a thin précis (the live-test defect) scores ~0.
const RESEARCH17_SOFT_FLOOR = 5;
const RESEARCH_TIMEOUT_MS = 15 * 60_000; // RUNS × one bounded web pass (15 fetches each; slower than decompose)

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

/** Median of a non-empty number list (robust central tendency — one network-flaky run can't sink it). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe.skipIf(!ENABLED)('RESEARCH-17 web-researcher depth eval (opt-in; real copilot + network)', () => {
  // The PRODUCTION web `ResearchFn` — the egress-gated live SDK session (same path the dispatcher runs),
  // with the BYOA copilot cliPath resolved off the login shell so it spawns under a packaged/GUI launch.
  const research = makeWebResearchFn({ cliPath: resolveCopilotCliPath() });

  // A `public-web` researcher at the RESEARCH-17 default budget (15 fetches). Empty allowedDomains =
  // the public-web default (any public host), so the agent can read several authoritative sources.
  const researcher: ResearcherConfig = {
    id: 'web-eval-research17',
    template: 'web',
    prompt: 'Research public-web topics and report a substantive, source-attributed findings-note.',
    egressTier: 'public-web',
    scope: 'global',
    budget: DEFAULT_RESEARCHER_BUDGET,
    schedule: 'off',
    posture: 'guarded',
    enabled: true,
  };
  // A fact-dense, stable, well-documented public topic so a real pass has ample specifics (dates,
  // crew names, figures, quotes) to attribute — the kind of source the pipeline mines for claims.
  const request: ResearchRequest = {
    id: 'eval-research17',
    ts: '2026-06-03T00:00:00.000Z',
    by: { stage: 'eval' },
    what: 'the Apollo 11 Moon landing mission',
    why: 'eval: exercise the RESEARCH-17 web-researcher depth bar',
    context: 'key dates, crew names, and mission figures',
    dedupKey: 'eval-research17',
  };

  it(
    `produces a SUBSTANTIVE attributed note: median countAttributedFacts ≥ ${RESEARCH17_SOFT_FLOOR} over ${RUNS} runs`,
    async () => {
      const counts: number[] = [];
      let failures = 0;
      console.log(`\n===== RESEARCH-17 WEB-RESEARCHER DEPTH EVAL =====`);
      for (let i = 0; i < RUNS; i++) {
        const f = await research(researcher, request);
        if (f.failed) {
          // A failed pass (SDK/CLI unavailable) is NOT a thin-note defect — surface it, don't score it.
          failures++;
          console.log(`run ${i + 1}/${RUNS}: research FAILED (not scored) — ${f.error ?? 'unknown'}`);
          continue;
        }
        const facts = countAttributedFacts(f.note);
        counts.push(facts);
        console.log(
          `run ${i + 1}/${RUNS}: found=${f.found} attributedFacts=${facts} citations=${f.citations.length}`,
        );
        console.log(`----- findings-note (run ${i + 1}) -----\n${f.note}\n----- end note -----`);
      }
      // Surface the aggregate the eval exists to REPORT (median + range), so a human judges the behavior.
      const summary = counts.length
        ? `median=${median(counts)} range=[${Math.min(...counts)}..${Math.max(...counts)}] over ${counts.length} scored run(s)`
        : 'no scored runs';
      console.log(`attributedFacts: ${summary}${failures ? ` | ${failures} failed run(s)` : ''}`);
      console.log(`===== END RESEARCH-17 EVAL =====\n`);

      // The live SDK/network must have been reachable for the eval to mean anything (failed ≠ empty,
      // #160): if EVERY pass failed, that's an environment problem to fix, not a silent pass.
      expect(counts.length, 'every web-research pass failed (BYOA copilot/network unavailable?)').toBeGreaterThan(0);
      // Soft floor (KB-QD-ratified N=5): the MEDIAN run clears the depth bar — a thin précis would score
      // ~0, a real multi-fact attributed note clears ≥5. Median (not every run) absorbs one flaky pass.
      expect(
        median(counts),
        `RESEARCH-17 depth: median attributed facts below the ${RESEARCH17_SOFT_FLOOR} soft floor — note(s) read thin`,
      ).toBeGreaterThanOrEqual(RESEARCH17_SOFT_FLOOR);
    },
    RESEARCH_TIMEOUT_MS,
  );
});
