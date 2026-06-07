// SPEC-0042 EVAL Slice-1 — the one real scenario end-to-end (EVAL-2/3/5). OPT-IN (real BYOA copilot +
// network + non-deterministic): runs only under KB_EVAL=1. It loads the declarative enrich scenario,
// drives it through the REAL pipeline via the runner, logs the resulting state (human-eyeball dogfood),
// and emits the deterministic scorecard — proving the harness end-to-end.
//
// CONSOLIDATION (KB-Lead ruling, in-slice): this SUPERSEDES the hand-wired `enrichE2eDogfood.eval.ts`,
// which is retired — its deterministic intent (DECOMP-17 granularity, CLAIMS citations, CONNECT-12
// wikilinks, ASK-7 recall) now lives as named checks in the durable home (validators.ts) driven by
// `enrich.yaml`, and its human-eyeball snapshot logging is preserved here via the runner's onSnapshot
// hook — off the SAME real-pipeline snapshot, so there's one source of truth, no parallel harness. The
// CLAIMS-19 within-source-dedup + a recall-specific scenario fold into the Slice-3 scenario library
// (EVAL-10); Slice-2's agent-judge adds fuzzy-quality scoring on top.
//
//   Run:  cd app && KB_EVAL=1 npm run eval:enrich    (or via the eval container, eval/Dockerfile)
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadScenario } from './runner/loader';
import { runScenario } from './runner/runScenario';
import { formatScorecard } from './runner/scorecard';
import type { VaultSnapshot } from './runner/snapshot';

const ENABLED = process.env.KB_EVAL === '1';
const TIMEOUT_MS = 15 * 60_000; // capture→decompose→connect→claims→recall over real copilot is slow

/** Human-eyeball dogfood log (preserves enrichE2eDogfood's value) — the actual entities/claims/recall. */
function logSnapshot(snap: VaultSnapshot): void {
  console.log(`\n===== ENRICH SCENARIO OUTPUT =====\nentities: ${snap.entities.length} | claims: ${snap.claims.length} | sources: ${snap.sources.length}`);
  for (const e of snap.entities) console.log(`\n----- ${e.path} -----\n${e.body}`);
  for (const c of snap.claims) console.log(`\n----- ${c.path} -----\n${c.body}`);
  if (snap.recall) console.log(`\nrecall: grounded=${snap.recall.grounded} citations=${snap.recall.citations.length}\nanswer: ${snap.recall.answer}`);
  console.log(`===== END ENRICH SCENARIO OUTPUT =====\n`);
}

describe.skipIf(!ENABLED)('SPEC-0042 EVAL Slice-1 — enrich scenario end-to-end (opt-in; real copilot)', () => {
  it(
    'drives eval/scenarios/enrich.yaml through the real pipeline, logs the state, and scores it',
    async () => {
      const scenario = await loadScenario(path.resolve(process.cwd(), 'eval/scenarios/enrich.yaml'));
      const scorecard = await runScenario(scenario, { onSnapshot: logSnapshot });
      // The scorecard IS the deliverable — print it for human judgment (quality is non-deterministic).
      console.log('\n' + formatScorecard(scorecard) + '\n');
      // Gross-failure guard: the harness ran the real pipeline end-to-end and scored every check. The
      // individual deterministic results are surfaced above; non-determinism means we don't hard-fail the
      // run on a single check here (that's the scorecard/baseline's job in Slice-2/3).
      expect(scorecard.scenarioId).toBe('enrich-hopper');
      expect(scorecard.total).toBe((scenario.expect.deterministic ?? []).length);
      expect(scorecard.total).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
