// Main-process owner of the active vault's orchestration engine (SPEC-0014). Holds the
// long-lived stages for the loaded KB; they keep draining while no window is open (the main
// process stays alive on macOS), satisfying the headless requirement.
//
// All stages share ONE canonical-writer lock per vault (SPEC-0014 §5 / SPEC-0015 §5): they
// run concurrently in their own worktrees but their canonical-ref advances serialize through
// the shared Mutex, so two stages never race on the root repo's index.lock.
//
// v1 handoffs (SPEC-0015 §6 / SPEC-0016 §3): there are no `queue/` folders yet, so each Enrich
// stage discovers work by sweeping a derived queue — Decompose sweeps sources/ for un-decomposed
// sources; Claims sweeps entities/ for entities with no terminal `claims` marker. When the
// upstream stage later pokes a queue folder, the downstream stage attaches there unchanged.
import { Orchestrator } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { DecomposeStage } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { ClaimsStage } from '../kb/claimsStage';
import { makeClaimsDecider } from '../kb/claimsAgent';
import { Mutex } from '../kb/stageLock';

let active: { path: string; orch: Orchestrator; decompose: DecomposeStage; claims: ClaimsStage } | null = null;

/** Start (or reuse) the pipeline for `vaultPath`, replacing any prior one. Archivist +
 *  Decompose + Claims stages share one canonical-writer lock and each run a Copilot session per
 *  item, falling back / retrying per their stage rules when Copilot is absent (ORCH-8). */
export function startPipeline(vaultPath: string): Orchestrator {
  if (active?.path === vaultPath) return active.orch;
  active?.orch.stop();
  active?.decompose.stop();
  active?.claims.stop();

  const lock = new Mutex(); // the shared serialized canonical writer for this vault (§5)
  const orch = new Orchestrator(vaultPath, makeCopilotDecider(), lock);
  const decompose = new DecomposeStage(vaultPath, makeDecomposeDecider(), lock);
  const claims = new ClaimsStage(vaultPath, makeClaimsDecider(), lock);
  orch.start();
  decompose.start();
  claims.start();
  active = { path: vaultPath, orch, decompose, claims };
  return orch;
}

/** The archivist orchestrator for the loaded KB, or null if none is active. */
export function activePipeline(): Orchestrator | null {
  return active?.orch ?? null;
}

/** Stop and clear the active pipeline (used on shutdown / vault switch). */
export function stopPipeline(): void {
  active?.orch.stop();
  active?.decompose.stop();
  active?.claims.stop();
  active = null;
}
