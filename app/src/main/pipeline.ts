// Main-process owner of the active vault's orchestration engine (SPEC-0014). Holds a
// single long-lived Orchestrator for the loaded KB; it keeps draining while no window is
// open (the main process stays alive on macOS), satisfying the headless requirement.
import { Orchestrator } from '../kb/orchestrator';

let active: { path: string; orch: Orchestrator } | null = null;

/** Start (or reuse) the orchestrator for `vaultPath`, replacing any prior one. */
export function startPipeline(vaultPath: string): Orchestrator {
  if (active?.path === vaultPath) return active.orch;
  active?.orch.stop();
  const orch = new Orchestrator(vaultPath);
  orch.start();
  active = { path: vaultPath, orch };
  return orch;
}

/** The orchestrator for the loaded KB, or null if none is active. */
export function activePipeline(): Orchestrator | null {
  return active?.orch ?? null;
}

/** Stop and clear the active pipeline (used on shutdown / vault switch). */
export function stopPipeline(): void {
  active?.orch.stop();
  active = null;
}
