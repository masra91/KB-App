// SPEC-0042 EVAL Slice-1 — the runner. Provisions an isolated clean-world KB (a temp vault), applies the
// seed, drives the action script through the REAL pipeline via the in-process ActionDriver (EVAL-2),
// snapshots the resulting state, runs the deterministic validators, and emits a scorecard. The container
// (eval/Dockerfile, EVAL-5) executes this entrypoint; locally it runs the same way under KB_EVAL.
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { resolveCopilotCliPath } from '../../src/main/researchWiring';
import { makeInProcessDriver, applyAction } from './actions';
import { captureSnapshot, type VaultSnapshot } from './snapshot';
import { runDeterministicChecks } from './validators';
import { buildScorecard, type Scorecard } from './scorecard';
import { runJudgeCheck, type JudgeResult, type JudgeSession } from './judge';
import type { Scenario } from './scenario';

export interface RunScenarioOptions {
  /** BYOA `copilot` cliPath; defaults to the login-shell-resolved path (so it spawns in dev + container). */
  cliPath?: string;
  /** Inspect the post-drain snapshot before scoring — preserves the human-eyeball dogfood logging that
   *  enrichE2eDogfood did, now off the SAME real-pipeline snapshot (KB-Lead: consolidate, don't fork). */
  onSnapshot?: (snapshot: VaultSnapshot) => void;
  /** Budget variant axis (EVAL-7) — recall's per-pass tool-call cap for this run. */
  recallMaxToolCalls?: number;
  /** Scorecard variant label (EVAL-7 matrix); 'default' when omitted. */
  variant?: string;
  /** Injected agent-judge session (tests); production uses the live pinned-model SDK judge. */
  judgeSession?: JudgeSession;
  /** Run the scenario's agent-judge checks (EVAL-4). Default true; set false for deterministic-only runs. */
  runJudge?: boolean;
}

/**
 * Run one scenario end-to-end and return its deterministic scorecard. A fresh ephemeral KB per run (no
 * host/global-state bleed — EVAL-5/11); the real deciders drive the cognition (EVAL-2). NB: non-model
 * determinism (ULID/`Date.now` seeding, SPEC-0011) is wired at the pipeline's existing injection points;
 * Slice-1's enrich validators don't depend on stable ids, and the broader matrix/seeding lands in later
 * slices. Slice-1 supports `seed.kind: empty`; `files`/`snapshot` seeding arrives with the scenario library.
 */
export async function runScenario(scenario: Scenario, opts: RunScenarioOptions = {}): Promise<Scorecard> {
  if (scenario.seed.kind !== 'empty') {
    throw new Error(`runScenario: seed kind '${scenario.seed.kind}' is not supported in Slice-1 (only 'empty')`);
  }
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    const cliPath = opts.cliPath ?? resolveCopilotCliPath();
    const driver = await makeInProcessDriver({ root, cliPath, ...(opts.recallMaxToolCalls ? { recallMaxToolCalls: opts.recallMaxToolCalls } : {}) });
    for (const action of scenario.actions) await applyAction(driver, action);
    const snap = await captureSnapshot(driver.rootPath, { recall: driver.lastRecall });
    opts.onSnapshot?.(snap); // human-eyeball hook (consolidates enrichE2eDogfood's logging)
    const checks = runDeterministicChecks(snap, scenario.expect.deterministic ?? []);
    // Agent-judge checks (EVAL-4) — the qualitative tier the deterministic validators can't cover.
    const judge: JudgeResult[] = [];
    const judgeChecks = scenario.expect.judge ?? [];
    if (judgeChecks.length > 0 && (opts.runJudge ?? true)) {
      for (const jc of judgeChecks) judge.push(await runJudgeCheck(jc, snap, { ...(opts.judgeSession ? { session: opts.judgeSession } : {}), ...(cliPath ? { cliPath } : {}) }));
    }
    return buildScorecard(scenario.id, scenario.capability, checks, opts.variant ?? 'default', judge);
  } finally {
    await rmTempDir(dir);
  }
}
