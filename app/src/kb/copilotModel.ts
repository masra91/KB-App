// The single source of truth for which model KB-App launches the Copilot CLI/SDK with
// (ORCH-16 / model-pinning gap). Before this, prod launched with NO `--model` flag: every
// decider read `process.env.KB_COPILOT_MODEL`, which ONLY the eval harness ever sets. With
// it unset in prod, the `copilot` CLI silently inherited the user's `~/.copilot/settings.json`
// (the Principal's build ran on gpt-5.5, not the intended model — the 40–150s/item slowness),
// and every AgentTrace recorded the model as `default` because the resolved model is never
// reported back to us. Evals pinned; prod didn't → divergence.
//
// The fix is to PIN a default in-app so prod always launches with a concrete `--model`. The
// eval harness keeps overriding per variant via `KB_COPILOT_MODEL` (set + restored around
// each run), so eval behavior is unchanged. Because the launch is now always pinned, the
// model recorded in every trace is the real, resolved model — no more `default`.

/** The Copilot model KB-App pins when nothing overrides it. `claude-opus-4.5` is the strongest
 *  model for the archival/enrich reasoning the pipeline does and matches the eval judge default
 *  (`eval/runner/judge.ts`). Change this one constant to re-pin every agent + recall at once.
 *
 *  MUST be an id the `copilot` CLI accepts: copilot validates `--model` PRE-FLIGHT and hard-rejects
 *  unknown ids (`Model "X" … not available`), which would throw on every decider launch and kill the
 *  whole pipeline. Verified against copilot CLI 0.0.373: `claude-opus-4.5` ✅ / `claude-sonnet-4.5` ✅;
 *  `claude-opus-4` ❌ (the original pin — rejected). Re-verify the live CLI before changing this. */
export const DEFAULT_COPILOT_MODEL = 'claude-opus-4.5';

/**
 * Resolve the model to launch the Copilot CLI/SDK with. An explicit `KB_COPILOT_MODEL` (the eval
 * harness sets this per variant) wins; otherwise the in-app prod pin. ALWAYS returns a concrete
 * model so the launch is deterministic and the trace records what actually ran (never `default`).
 *
 * `env` is injectable so this stays a pure, unit-testable function (no hidden global read in tests).
 */
export function resolveCopilotModel(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KB_COPILOT_MODEL;
  return override && override.trim().length > 0 ? override : DEFAULT_COPILOT_MODEL;
}
