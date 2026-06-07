// SPEC-0042 EVAL Slice-3 — the full-breadth scenario library end-to-end (EVAL-10), opt-in. Runs EVERY
// declarative scenario in eval/scenarios/ through the SAME runner used by the unit tests (one harness, no
// fork — this SUPERSEDES the enrich-only scenario.eval.ts: consolidate, don't fork — KB-Lead's #241 rule).
// Each scenario drives the REAL pipeline/cognition (EVAL-2); research scenarios replay the egress cassette
// (EVAL-6); the snapshot is logged for human-eyeball dogfood (preserving enrichE2eDogfood's value), then
// scored (deterministic + agent-judge) and diffed vs baseline.
//
// OPT-IN: needs a real BYOA copilot + network, so it self-skips unless KB_EVAL=1.
//   Run:    cd app && KB_EVAL=1 npm run eval
//   Record: cd app && KB_EVAL=1 KB_EVAL_RECORD=1 npm run eval   (refresh research cassettes via --live)
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadScenario } from './runner/loader';
import { runMatrix } from './runner/runMatrix';
import { formatScorecard } from './runner/scorecard';
import type { VaultSnapshot } from './runner/snapshot';

const ENABLED = process.env.KB_EVAL === '1';
const TIMEOUT_MS = 30 * 60_000; // capture→decompose→connect→claims→recall/research/jobs over real copilot is slow
const SCENARIOS_DIR = path.resolve(process.cwd(), 'eval/scenarios');

/** Human-eyeball dogfood log (preserves enrichE2eDogfood's value) — the actual entities/claims/recall. */
function logSnapshot(id: string, snap: VaultSnapshot): void {
  console.log(`\n===== ${id} OUTPUT =====\nentities: ${snap.entities.length} | claims: ${snap.claims.length} | sources: ${snap.sources.length} | outputs: ${snap.outputs.length}`);
  for (const e of snap.entities) console.log(`\n----- ${e.path} -----\n${e.body}`);
  for (const c of snap.claims) console.log(`\n----- ${c.path} -----\n${c.body}`);
  for (const s of snap.sources) console.log(`\n----- ${s.path} -----\n${s.body}`);
  for (const o of snap.outputs) console.log(`\n----- ${o.path} -----\n${o.body}`);
  if (snap.recall) console.log(`\nrecall: grounded=${snap.recall.grounded} citations=${snap.recall.citations.length}\nanswer: ${snap.recall.answer}`);
  console.log(`===== END ${id} OUTPUT =====\n`);
}

describe.skipIf(!ENABLED)('SPEC-0042 EVAL Slice-3 — full scenario library end-to-end (opt-in; real copilot)', () => {
  it(
    'drives every eval/scenarios/*.yaml through the real pipeline, logs the state, and scores it',
    async () => {
      const files = (await fs.readdir(SCENARIOS_DIR)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
      expect(files.length).toBeGreaterThanOrEqual(8); // EVAL-10: ≥1 scenario per capability
      const capabilities = new Set<string>();
      for (const file of files) {
        const scenario = await loadScenario(path.join(SCENARIOS_DIR, file));
        capabilities.add(scenario.capability);
        const results = await runMatrix(scenario, { onSnapshot: (snap) => logSnapshot(scenario.id, snap) });
        for (const { scorecard, diff, manifest } of results) {
          console.log('\n' + formatScorecard(scorecard));
          console.log(`baseline: ${diff.regressions} regression(s), ${diff.improvements} improvement(s)`);
          console.log(`manifest: sut=${manifest.sutModel} judge=${manifest.judgeModel} node=${manifest.node} @ ${manifest.at}`);
          // Gross-failure guard: the matrix scored every declared check (non-determinism is the
          // scorecard/baseline's job, not a hard per-check fail here).
          expect(scorecard.total).toBe((scenario.expect.deterministic ?? []).length);
          expect(scorecard.judge.length).toBe((scenario.expect.judge ?? []).length);
        }
      }
      // EVAL-10: the library covers all eight capabilities.
      for (const cap of ['ingest', 'decompose', 'connect', 'claims', 'recall', 'research', 'reflect', 'jobs']) {
        expect(capabilities.has(cap)).toBe(true);
      }
    },
    TIMEOUT_MS,
  );
});
