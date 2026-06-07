// SPEC-0042 EVAL Slice-1 — the one real scenario end-to-end (EVAL-2/3/5). OPT-IN (real BYOA copilot +
// network + non-deterministic): runs only under KB_EVAL=1, like enrichE2eDogfood. It loads the declarative
// enrich scenario, drives it through the REAL pipeline via the runner, and emits the deterministic
// scorecard — proving the harness end-to-end (loader → action driver → snapshot → validators → scorecard).
//
//   Run:  cd app && KB_EVAL=1 npm run eval:enrich    (or via the eval container, eval/Dockerfile)
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadScenario } from './runner/loader';
import { runScenario } from './runner/runScenario';
import { formatScorecard } from './runner/scorecard';

const ENABLED = process.env.KB_EVAL === '1';
const TIMEOUT_MS = 15 * 60_000; // capture→decompose→connect→claims→recall over real copilot is slow

describe.skipIf(!ENABLED)('SPEC-0042 EVAL Slice-1 — enrich scenario end-to-end (opt-in; real copilot)', () => {
  it(
    'drives eval/scenarios/enrich.yaml through the real pipeline and scores it',
    async () => {
      const scenario = await loadScenario(path.resolve(process.cwd(), 'eval/scenarios/enrich.yaml'));
      const scorecard = await runScenario(scenario);
      // The scorecard IS the deliverable — print it for human judgment (quality is non-deterministic).
      console.log('\n' + formatScorecard(scorecard) + '\n');
      // Gross-failure guard: the harness ran the real pipeline end-to-end and scored every check. The
      // individual deterministic results are surfaced above; non-determinism means we don't hard-fail
      // the run on a single check here (that's the scorecard/baseline's job in Slice-2/3).
      expect(scorecard.scenarioId).toBe('enrich-hopper');
      expect(scorecard.total).toBe((scenario.expect.deterministic ?? []).length);
      expect(scorecard.total).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
