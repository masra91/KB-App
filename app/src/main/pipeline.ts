// Main-process owner of the active vault's orchestration engine (SPEC-0014). Holds the
// long-lived stages for the loaded KB; they keep draining while no window is open (the main
// process stays alive on macOS), satisfying the headless requirement.
//
// Both stages share ONE canonical-writer lock per vault (SPEC-0014 §5 / SPEC-0015 §5): they
// run concurrently in their own worktrees but their canonical-ref advances serialize through
// the shared Mutex, so two stages never race on the root repo's index.lock.
//
// v1 handoff (SPEC-0015 §6): the archivist does not yet enqueue an Enrich queue, so Decompose
// discovers freshly-archived sources by sweeping sources/ (its derived queue). When the
// archivist later pokes a queue folder, Decompose attaches there with no change to its logic.
import { Orchestrator } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { DecomposeStage } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { Mutex } from '../kb/stageLock';

let active: { path: string; orch: Orchestrator; decompose: DecomposeStage } | null = null;

/** Start (or reuse) the pipeline for `vaultPath`, replacing any prior one. Archivist +
 *  Decompose stages share one canonical-writer lock and each run a Copilot session per item,
 *  falling back / retrying per their stage rules when Copilot is absent (ORCH-8). */
export function startPipeline(vaultPath: string): Orchestrator {
  if (active?.path === vaultPath) return active.orch;
  active?.orch.stop();
  active?.decompose.stop();

  const lock = new Mutex(); // the shared serialized canonical writer for this vault (§5)
  const orch = new Orchestrator(vaultPath, makeCopilotDecider(), lock);
  const decompose = new DecomposeStage(vaultPath, makeDecomposeDecider(), lock);
  orch.start();
  decompose.start();
  active = { path: vaultPath, orch, decompose };
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
  active = null;
}
