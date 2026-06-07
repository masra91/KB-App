// SPEC-0042 EVAL Slice-2 — the variant matrix (EVAL-7). A scenario runs across config variants
// {model, budget} (ratified S2-A: model + budget axes ship now; promptVersion/toolConfig defer to the
// prompt-version registry follow-up). `applyVariant` sets the config around a `runScenario` call and
// returns a restore() so the matrix can run variants sequentially without bleed. Pure-ish (only the
// model env is process-global, captured + restored); unit-tested.
import type { ScenarioVariant } from './scenario';

export interface ResolvedVariant {
  label: string;
  /** Budget axis → recall's per-pass tool-call cap for this variant (undefined = scenario default). */
  recallMaxToolCalls?: number;
  /** Undo the process-global config this variant set (the model env), restoring the prior value. */
  restore: () => void;
}

/** A stable label for a variant (the scorecard column / baseline key). `default` = the empty variant. */
export function variantLabel(v: ScenarioVariant): string {
  const parts: string[] = [];
  if (v.model) parts.push(`model=${v.model}`);
  const mtc = (v.budget as { maxToolCalls?: unknown } | undefined)?.maxToolCalls;
  if (typeof mtc === 'number') parts.push(`budget=${mtc}`);
  return parts.length ? parts.join(';') : 'default';
}

/**
 * Apply a variant's config for the next run + return how to restore it. The `model` axis sets
 * `KB_COPILOT_MODEL` (read by every decider + recall); the `budget` axis surfaces `maxToolCalls`. The
 * DEFERRED axes (promptVersion/toolConfig) FAIL FAST if a scenario uses them (no silent ignore) — they
 * land with the prompt-version registry (KB-Lead's ratified sequencing).
 */
export function applyVariant(v: ScenarioVariant): ResolvedVariant {
  if (v.promptVersion !== undefined || v.toolConfig !== undefined) {
    throw new Error('variant axes promptVersion/toolConfig are deferred (Slice-2 ships model + budget; they land with the prompt-version registry)');
  }
  const prevModel = process.env.KB_COPILOT_MODEL;
  if (v.model) process.env.KB_COPILOT_MODEL = v.model;
  const mtc = (v.budget as { maxToolCalls?: unknown } | undefined)?.maxToolCalls;
  return {
    label: variantLabel(v),
    recallMaxToolCalls: typeof mtc === 'number' && mtc > 0 ? mtc : undefined,
    restore() {
      if (v.model === undefined) return; // didn't touch the env
      if (prevModel === undefined) delete process.env.KB_COPILOT_MODEL;
      else process.env.KB_COPILOT_MODEL = prevModel;
    },
  };
}

/** The variants to run for a scenario — the declared matrix, or a single default variant when none. */
export function expandMatrix(variants: ScenarioVariant[] | undefined): ScenarioVariant[] {
  return variants && variants.length > 0 ? variants : [{}];
}
