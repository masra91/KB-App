// SPEC-0042 EVAL Slice-1/3 — the runner. Provisions an isolated clean-world KB (a temp vault), applies the
// seed, drives the action script through the REAL pipeline via the in-process ActionDriver (EVAL-2),
// snapshots the resulting state, runs the deterministic validators, and emits a scorecard. The container
// (eval/Dockerfile, EVAL-5) executes this entrypoint; locally it runs the same way under KB_EVAL.
// Slice-3 adds: seed.kind 'files' (fixture-seeded KBs) + the egress cassette for research scenarios.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { resolveCopilotCliPath } from '../../src/main/researchWiring';
import { makeInProcessDriver, applyAction } from './actions';
import { captureSnapshot, type VaultSnapshot, type VaultFile } from './snapshot';
import { runDeterministicChecks } from './validators';
import { buildScorecard, type Scorecard } from './scorecard';
import { runJudgeCheck, type JudgeResult, type JudgeSession } from './judge';
import { type EgressController, makeReplayEgress, makeRecordEgress } from './egress';
import { loadCassette, saveCassette } from './cassetteStore';
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
  /** Slice-3: inject the egress controller directly (tests). Otherwise resolved from the cassette. */
  egress?: EgressController;
  /** Slice-3: RECORD the research cassette this run (`--live`) instead of replaying it. Default false
   *  (replay) — or set via KB_EVAL_RECORD=1. A record run refreshes the committed cassette on disk. */
  record?: boolean;
  /** Slice-3: override the fixtures root (seed.kind 'files'); defaults to `eval/fixtures`. */
  fixturesRoot?: string;
  /** Slice-3: override the cassettes root; defaults to `eval/cassettes`. */
  cassettesRoot?: string;
}

/** Recursively collect a fixtures dir into VaultFiles (repo-relative to the dir) for seed.kind 'files'. */
async function loadSeedFiles(dir: string): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push({ path: path.relative(dir, abs), body: await fs.readFile(abs, 'utf8') });
    }
  }
  await walk(dir);
  return out;
}

/** The cassette file for a research scenario: `<meta.cassette>` (relative to cassettesRoot) or `<id>.json`. */
function cassetteFileFor(scenario: Scenario, cassettesRoot: string): string {
  const named = (scenario.meta as { cassette?: unknown } | undefined)?.cassette;
  return path.join(cassettesRoot, typeof named === 'string' ? named : `${scenario.id}.json`);
}

/**
 * Run one scenario end-to-end and return its scorecard. A fresh ephemeral KB per run (no host/global-state
 * bleed — EVAL-5/11); the real deciders drive the cognition (EVAL-2). Supports seed.kind 'empty' + 'files'
 * (a fixture-seeded KB); 'snapshot' is not yet used by the library. A research scenario (a dispatchResearcher
 * action) runs through the egress cassette — REPLAY by default (deterministic, no live web), or RECORD with
 * `--live`/KB_EVAL_RECORD=1 to refresh the committed cassette.
 */
export async function runScenario(scenario: Scenario, opts: RunScenarioOptions = {}): Promise<Scorecard> {
  if (scenario.seed.kind === 'snapshot') {
    throw new Error(`runScenario: seed kind 'snapshot' is not supported by the Slice-3 scenario library (use 'empty' or 'files')`);
  }
  const cwd = process.cwd();
  const fixturesRoot = opts.fixturesRoot ?? path.resolve(cwd, 'eval/fixtures');
  const cassettesRoot = opts.cassettesRoot ?? path.resolve(cwd, 'eval/cassettes');
  const seedFiles = scenario.seed.kind === 'files' ? await loadSeedFiles(path.resolve(fixturesRoot, scenario.seed.ref)) : [];

  // Resolve the egress cassette for a research scenario (replay default; record refreshes the cassette).
  const needsEgress = scenario.actions.some((a) => 'dispatchResearcher' in a);
  const recording = opts.record ?? process.env.KB_EVAL_RECORD === '1';
  const cassetteFile = needsEgress ? cassetteFileFor(scenario, cassettesRoot) : '';
  let egress: EgressController | undefined = opts.egress;
  if (!egress && needsEgress) egress = recording ? makeRecordEgress() : makeReplayEgress(await loadCassette(cassetteFile));

  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    const cliPath = opts.cliPath ?? resolveCopilotCliPath();
    const driver = await makeInProcessDriver({
      root,
      cliPath,
      ...(opts.recallMaxToolCalls ? { recallMaxToolCalls: opts.recallMaxToolCalls } : {}),
      ...(seedFiles.length ? { seedFiles } : {}),
      ...(egress ? { egress } : {}),
    });
    for (const action of scenario.actions) await applyAction(driver, action);
    // Record run: persist the refreshed cassette (asserted clean / secret-free) before scoring.
    if (recording && needsEgress && egress) {
      const cassette = egress.recorded();
      if (cassette) await saveCassette(cassetteFile, cassette);
    }
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
