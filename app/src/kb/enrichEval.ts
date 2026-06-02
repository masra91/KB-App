// Enrich-quality EVAL logic (the behavioral close for DECOMP-17 / SPEC-0015, per KB-QD's pass-bar).
//
// Granularity is LLM-judged, so the deterministic unit tests (decomposeAgent.test.ts for the prompt
// policy, claimDedup.test.ts for the dedup core) prove the *mechanism*, not the *behavior*. This
// module is the PURE scoring core for an OPT-IN eval that runs decompose/v2 over a curated golden
// set and asserts the behavior directly. The eval RUNNER (real `copilot`, network) lives under
// `eval/` so it never runs in the CI unit suite (vitest `include` is `src/**`); this scoring logic
// lives in `src/` so it is unit-tested + coverage-gated. KB-QD's pass-bar (the contract this
// encodes):
//   1. Per fixture, DIRECTIONAL + bounded — NOT exact counts (LLM output is non-deterministic):
//      (a) a must-be-node set (the genuine entities ARE extracted — recall);
//      (b) a must-NOT-be-node set (roles/descriptors/relationships do NOT become nodes — precision;
//          the dogfood "first computer programmer"-type cases);
//      (c) total node count ≤ a loose upper bound (the over-extraction regression guard).
//   2. The (a)/(b) SET assertions are HARD; ±tolerance applies only to raw totals. Run each fixture
//      N≥3× and require the set-assertions hold in EVERY run; report counts as median + range.
import type { DecomposeDecision } from './decompose';

/** One curated granularity fixture. The golden set itself lives in `eval/granularityFixtures.ts`. */
export interface GranularityFixture {
  name: string;
  /** ~A few sentences. The dogfood headline: 2 sentences that used to yield 6 nodes. */
  sourceText: string;
  /** Entities that MUST be extracted as nodes (recall — HARD). Matched case/space-insensitively. */
  mustBeNodes: string[];
  /** Descriptors/roles/relationships that MUST NOT become nodes — they belong in Claims (precision —
   *  HARD). A node whose name equals OR contains one of these (normalized) is a precision failure. */
  mustNotBeNodes: string[];
  /** Loose upper bound on total node count — the over-extraction regression guard. */
  maxNodes: number;
}

/** The outcome of scoring ONE decompose decision against a fixture. */
export interface GranularityCheck {
  fixture: string;
  nodeCount: number;
  missingMustBe: string[]; // expected entities NOT extracted (recall failures)
  presentMustNot: string[]; // descriptors that DID become nodes (precision failures)
  overMax: boolean; // nodeCount > maxNodes — LOOSE/reported, NOT part of `pass` (see below)
  pass: boolean; // the HARD checks held: recall + precision only (the count bound is loose — `overMax`)
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Score ONE decompose decision against a fixture. Recall: every `mustBeNodes` name must match some
 * extracted node (normalized equality). Precision: no `mustNotBeNodes` descriptor may appear as a
 * node — matched by normalized equality OR substring (so "first computer programmer" is caught
 * whether the agent names the node exactly that or "the first computer programmer"). Recall +
 * precision are **HARD** (part of `pass`); the count bound `nodeCount ≤ maxNodes` is **LOOSE** —
 * surfaced as `overMax` and reported (median/range), but NOT part of `pass`, per the pass-bar's
 * "±tolerance only on raw totals" (KB-QD bar item 2). The aggregate verdict mirrors this.
 */
export function evaluateGranularity(decision: DecomposeDecision, fixture: GranularityFixture): GranularityCheck {
  const nodeNames = decision.entities.map((e) => norm(e.name));
  const nodeNameSet = new Set(nodeNames);
  const missingMustBe = fixture.mustBeNodes.filter((n) => !nodeNameSet.has(norm(n)));
  const presentMustNot = fixture.mustNotBeNodes.filter((bad) => {
    const b = norm(bad);
    return nodeNames.some((name) => name === b || name.includes(b));
  });
  const nodeCount = decision.entities.length;
  const overMax = nodeCount > fixture.maxNodes;
  return {
    fixture: fixture.name,
    nodeCount,
    missingMustBe,
    presentMustNot,
    overMax,
    // HARD = recall + precision only; the count bound is loose (`overMax`), never fails `pass`.
    pass: missingMustBe.length === 0 && presentMustNot.length === 0,
  };
}

/** Aggregate across N runs of the same fixture (KB-QD bar item 2: robustness to non-determinism). */
export interface GranularityAggregate {
  fixture: string;
  runs: number;
  /** The HARD set-assertions (recall + precision) held in EVERY run — the real pass/fail. */
  passedAllRuns: boolean;
  nodeCounts: number[]; // per-run total node counts
  medianNodes: number;
  minNodes: number;
  maxNodes: number;
  /** Union across runs, for the report (which expected entities were ever missed / which descriptors
   *  ever leaked into nodes / how often the loose bound was exceeded). */
  everMissingMustBe: string[];
  everPresentMustNot: string[];
  runsOverMax: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Fold N per-run checks for one fixture into a verdict. `passedAllRuns` requires the HARD set
 * assertions (recall + precision) to hold in EVERY run — the deterministic-enough bar for an
 * LLM-judged behavior. The loose total bound is reported (runsOverMax) but, per the pass-bar's
 * "±tolerance only on raw totals", does NOT itself fail the aggregate — a reviewer reads the
 * median/range to judge over-extraction.
 */
export function aggregateRuns(fixtureName: string, checks: readonly GranularityCheck[]): GranularityAggregate {
  const nodeCounts = checks.map((c) => c.nodeCount);
  const everMissingMustBe = [...new Set(checks.flatMap((c) => c.missingMustBe))].sort();
  const everPresentMustNot = [...new Set(checks.flatMap((c) => c.presentMustNot))].sort();
  const passedAllRuns = checks.length > 0 && everMissingMustBe.length === 0 && everPresentMustNot.length === 0;
  return {
    fixture: fixtureName,
    runs: checks.length,
    passedAllRuns,
    nodeCounts,
    medianNodes: median(nodeCounts),
    minNodes: nodeCounts.length ? Math.min(...nodeCounts) : 0,
    maxNodes: nodeCounts.length ? Math.max(...nodeCounts) : 0,
    everMissingMustBe,
    everPresentMustNot,
    runsOverMax: checks.filter((c) => c.overMax).length,
  };
}

/** A one-line human summary of an aggregate (for the opt-in runner's report). */
export function formatAggregate(a: GranularityAggregate): string {
  const verdict = a.passedAllRuns ? 'PASS' : 'FAIL';
  const counts = `nodes median ${a.medianNodes} (range ${a.minNodes}–${a.maxNodes}) over ${a.runs} run(s)`;
  const recall = a.everMissingMustBe.length ? `; MISSING: ${a.everMissingMustBe.join(', ')}` : '';
  const precision = a.everPresentMustNot.length ? `; LEAKED-AS-NODE: ${a.everPresentMustNot.join(', ')}` : '';
  const over = a.runsOverMax ? `; over-max in ${a.runsOverMax}/${a.runs}` : '';
  return `[${verdict}] ${a.fixture}: ${counts}${recall}${precision}${over}`;
}
