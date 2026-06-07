// SPEC-0042 EVAL Slice-1/3 — the ActionDriver seam (fork #1, RATIFIED in-process). Each scenario verb
// maps to the REAL pipeline/cognition (EVAL-2: never mock the model-under-test). The in-process driver
// (below) generalizes exactly what enrichE2eDogfood does; the interface keeps a packaged-app/IPC driver
// droppable later without touching scenarios or validators. Slice-3 wires the remaining verbs:
// dispatchResearcher (through the egress cassette) + runJob (the JOBS engine: example + reflect).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
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
import { readResearcherRegistry } from '../../src/kb/researcherRegistry';
import { runResearcher } from '../../src/kb/researchRun';
import { selectResearchFn } from '../../src/kb/researchInline';
import { researchWhatFor, dedupKeyFor, type ResearchRequest } from '../../src/kb/researchers';
import type { WebResearchOptions } from '../../src/kb/researchWebAgent';
import { readJobRegistry } from '../../src/kb/jobRegistry';
import { runJobOnce } from '../../src/kb/jobStage';
import type { JobBehavior } from '../../src/kb/jobs';
import { exampleJobBehavior, EXAMPLE_JOB_TYPE } from '../../src/kb/exampleJob';
import { makeReflectJobBehavior, REFLECT_JOB_TYPE } from '../../src/kb/reflectJob';
import { makeReflectDecider } from '../../src/kb/reflectAgent';
import type { ScenarioAction } from './scenario';
import type { VaultFile } from './snapshot';
import type { EgressController } from './egress';

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

export interface InProcessDriverOptions {
  root: string;
  cliPath?: string;
  recallMaxToolCalls?: number;
  /** Slice-3: the egress cassette controller a research scenario dispatches through (replay default). */
  egress?: EgressController;
  /** Slice-3: fixture files (seed.kind 'files') written + committed to the canonical KB before driving —
   *  e.g. a seeded researcher/job registry or pre-existing entities a reflect/research scenario needs. */
  seedFiles?: VaultFile[];
}

/** Resolve a registered job's `type` to its behavior — mirrors the orchestrator's `resolveJobBehavior`
 *  (SPEC-0023): the deterministic `example` job + the real `reflect` job (live decider). */
function resolveEvalJobBehavior(type: string): JobBehavior | null {
  if (type === EXAMPLE_JOB_TYPE) return exampleJobBehavior;
  if (type === REFLECT_JOB_TYPE) return makeReflectJobBehavior(makeReflectDecider());
  return null;
}

/**
 * Build the in-process driver over a fresh KB at `root` (fork #1). Wires the real deciders
 * (`makeXDecider` → BYOA copilot) — the model-under-test is never mocked. Mirrors enrichE2eDogfood's
 * capture→drain→recall flow; Slice-3 adds research (via the egress cassette) + jobs (the JOBS engine).
 */
export async function makeInProcessDriver(opts: InProcessDriverOptions): Promise<ActionDriver> {
  const root = opts.root;
  await createKb({ path: root, initGitIfNeeded: true });
  // seed.kind 'files' (Slice-3): write fixtures + commit to the canonical branch BEFORE the staging
  // worktree branches off it, so a seeded researcher/job registry + entities are visible to the run.
  if (opts.seedFiles?.length) {
    for (const f of opts.seedFiles) {
      const dest = path.join(root, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.body, 'utf8');
    }
    const git = simpleGit(root);
    await git.add('-A');
    await git.commit('eval: seed scenario fixtures');
  }
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
      lastRecall = await recall(root, a.query, {
        ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
        ...(opts.recallMaxToolCalls ? { maxToolCalls: opts.recallMaxToolCalls } : {}), // budget variant axis (EVAL-7)
      });
      return lastRecall;
    },
    async runJob(a) {
      // JOBS engine (SPEC-0023): resolve the seeded job's behavior, run ONE bounded pass on staging via
      // the real runner (optimistic-advance + journal + posture), then promote evergreen artifacts to root
      // so the snapshot sees them (JOBS-12). Mirrors the production scheduler/run-now path.
      const job = (await readJobRegistry(stagingWt)).find((j) => j.id === a.id);
      if (!job) throw new Error(`runJob: no job '${a.id}' in the registry — seed it via scenario seed.kind 'files'`);
      const behavior = resolveEvalJobBehavior(job.type);
      if (!behavior) throw new Error(`runJob: unknown job type '${job.type}' (no behavior; mirrors resolveJobBehavior)`);
      await runJobOnce(stagingWt, job, behavior, lock);
      await promoteEvergreen();
    },
    async dispatchResearcher(a) {
      // RESEARCH (SPEC-0028) through the egress cassette (Slice-3 S3-A): find the seeded researcher, build
      // a run-now-style request (researchWhatFor → real name, never the template word, WS1 #6), and run it
      // on staging (so the finding re-enters the pipeline + audits, exactly like runActiveResearcherNow).
      // The cassette `makeFetch` is injected behind WebResearchOptions; production omits it (live gate).
      const r = (await readResearcherRegistry(stagingWt)).find((x) => x.id === a.id);
      if (!r) throw new Error(`dispatchResearcher: no researcher '${a.id}' in the registry — seed it via scenario seed.kind 'files'`);
      const what = researchWhatFor(r);
      const req: ResearchRequest = {
        id: `eval-req-${r.id}`,
        ts: '1970-01-01T00:00:00.000Z',
        by: { stage: 'panel' },
        what,
        why: 'eval scenario dispatch',
        context: '',
        dedupKey: dedupKeyFor({ what, by: {} }),
      };
      const web: WebResearchOptions = {
        ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
        ...(opts.egress ? { makeFetch: opts.egress.makeFetch } : {}),
      };
      await runResearcher(stagingWt, r, req, { research: selectResearchFn(stagingWt, r, { web }) });
    },
    async setConfig() {
      throw new Error('ActionDriver.setConfig: config-mutation scenarios are out of scope for the SPEC-0042 capability library');
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
