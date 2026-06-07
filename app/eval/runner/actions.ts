// SPEC-0042 EVAL Slice-1 — the ActionDriver seam (fork #1, RATIFIED in-process). Each scenario verb
// maps to the REAL pipeline/cognition (EVAL-2: never mock the model-under-test). The in-process driver
// (below) generalizes exactly what enrichE2eDogfood does; the interface keeps a packaged-app/IPC driver
// droppable later without touching scenarios or validators.
import { createKb } from '../../src/kb/vault';
import { ensureStagingWorktree } from '../../src/kb/stagingWorktree';
import { Mutex } from '../../src/kb/stageLock';
import { promote } from '../../src/kb/staging';
import { Orchestrator } from '../../src/kb/orchestrator';
import { makeCopilotDecider } from '../../src/kb/copilotAgent';
import { decomposeOne, readDecomposeQueue } from '../../src/kb/decomposeStage';
import { makeDecomposeDecider } from '../../src/kb/decomposeAgent';
import { ConnectStage } from '../../src/kb/connectStage';
import { makeConnectDecider } from '../../src/kb/connectAgent';
import { ClaimsStage } from '../../src/kb/claimsStage';
import { makeClaimsDecider } from '../../src/kb/claimsAgent';
import { recall, type AskResult } from '../../src/kb/recall';
import type { ScenarioAction } from './scenario';

/** Drives a scenario's verbs against the real KB. The runner builds one per scenario run, applies the
 *  action script, then snapshots `rootPath` + `lastRecall`. */
export interface ActionDriver {
  readonly rootPath: string;
  /** The most recent `ask` result (null until the first `ask`). */
  readonly lastRecall: AskResult | null;
  ingest(args: { text?: string; id?: string }): Promise<void>;
  awaitDrain(args: { stages: Array<'decompose' | 'connect' | 'claims'> }): Promise<void>;
  ask(args: { query: string }): Promise<AskResult>;
  runJob(args: { id: string }): Promise<void>;
  dispatchResearcher(args: { id: string }): Promise<void>;
  setConfig(args: Record<string, unknown>): Promise<void>;
}

/**
 * Build the in-process driver over a fresh KB at `root` (fork #1). Wires the real deciders
 * (`makeXDecider` → BYOA copilot) — the model-under-test is never mocked. Mirrors enrichE2eDogfood's
 * capture→drain→recall flow. Verbs not needed by Slice-1's enrich scenario (runJob/dispatchResearcher/
 * setConfig) throw a clear per-slice error rather than silently no-op.
 */
export async function makeInProcessDriver(opts: { root: string; cliPath?: string }): Promise<ActionDriver> {
  const root = opts.root;
  await createKb({ path: root, initGitIfNeeded: true });
  const stagingWt = await ensureStagingWorktree(root);
  const lock = new Mutex();
  const promoteEvergreen = async (): Promise<void> => {
    await promote(root);
  };
  const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen);
  let lastRecall: AskResult | null = null;
  let captureN = 0;
  const connectPoke = (): Promise<void> => new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen).poke();

  return {
    rootPath: root,
    get lastRecall() {
      return lastRecall;
    },
    async ingest(a) {
      const id = a.id ?? `note-${++captureN}`;
      await orch.capture(id, [{ kind: 'text', text: a.text ?? '' }]);
    },
    async awaitDrain(a) {
      await orch.poke(); // archive captured notes → sources/ → decompose queue
      for (const stage of a.stages) {
        if (stage === 'decompose') {
          for (const srcRel of await readDecomposeQueue(stagingWt)) await decomposeOne(stagingWt, srcRel, makeDecomposeDecider());
        } else if (stage === 'connect') {
          await connectPoke();
        } else if (stage === 'claims') {
          await new ClaimsStage(stagingWt, makeClaimsDecider(), lock, undefined, promoteEvergreen).poke();
        }
      }
      // Settle link-promotion (relatesTo → [[wikilinks]]) at top level after claims drains, lock-free —
      // claims' afterDrain can't await connect under the canonical-writer lock (deadlock); enrichE2eDogfood
      // does the same explicit settle.
      if (a.stages.includes('claims') && a.stages.includes('connect')) await connectPoke();
    },
    async ask(a) {
      lastRecall = await recall(root, a.query, opts.cliPath ? { cliPath: opts.cliPath } : {});
      return lastRecall;
    },
    async runJob() {
      throw new Error('ActionDriver.runJob: jobs scenarios are not wired in Slice-1');
    },
    async dispatchResearcher() {
      throw new Error('ActionDriver.dispatchResearcher: research scenarios need the egress record/replay store (Slice-3)');
    },
    async setConfig() {
      throw new Error('ActionDriver.setConfig: not wired in Slice-1');
    },
  };
}

/** Apply one scenario action to the driver — the exhaustive verb→driver mapping (EVAL-1). */
export async function applyAction(driver: ActionDriver, action: ScenarioAction): Promise<void> {
  if ('ingest' in action) return driver.ingest(action.ingest);
  if ('awaitDrain' in action) return driver.awaitDrain(action.awaitDrain);
  if ('ask' in action) {
    await driver.ask(action.ask);
    return;
  }
  if ('runJob' in action) return driver.runJob(action.runJob);
  if ('dispatchResearcher' in action) return driver.dispatchResearcher(action.dispatchResearcher);
  if ('setConfig' in action) return driver.setConfig(action.setConfig);
  throw new Error(`applyAction: unknown action ${JSON.stringify(action)}`);
}
