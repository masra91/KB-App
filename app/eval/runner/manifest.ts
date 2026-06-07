// SPEC-0042 EVAL Slice-2 — reproducibility manifest (EVAL-9). Every run records the model + prompt
// versions + variant + judge model + runtime, so a result is attributable + re-runnable. Pure (env +
// passed-in inputs); the container (eval/Dockerfile, EVAL-5) pins the deps/CLI the manifest references.
import { DECOMPOSE_PROMPT_VERSION } from '../../src/kb/decomposeAgent';
import { resolveJudgeModel } from './judge';

export interface ReproManifest {
  scenarioId: string;
  variant: string;
  /** The requested system-under-test model (KB_COPILOT_MODEL), or the SDK default. */
  sutModel: string;
  /** The pinned judge model (EVAL-4), distinct from the SUT. */
  judgeModel: string;
  /** Prompt versions in play (the model output's other input). */
  promptVersions: Record<string, string>;
  /** Node runtime (the container pins this; recorded for attribution). */
  node: string;
  /** ISO timestamp of the run (stamped by the caller). */
  at: string;
}

/** Build the manifest for a run (EVAL-9). `at` is passed in so the function stays pure/testable. */
export function buildManifest(scenarioId: string, variant: string, at: string): ReproManifest {
  return {
    scenarioId,
    variant,
    sutModel: process.env.KB_COPILOT_MODEL || 'copilot-default',
    judgeModel: resolveJudgeModel(),
    promptVersions: { decompose: DECOMPOSE_PROMPT_VERSION },
    node: process.version,
    at,
  };
}
