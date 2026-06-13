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
// ORCH-28 model-resilience: the model PROBED + selected from the preference list against the live
// CLI's accepted catalog at startup (copilotModelProbe.initLaunchModel sets this). It sits between the
// eval env-override and the hardcoded floor: an explicit `KB_COPILOT_MODEL` still wins (eval), then the
// probed-resolved model (the real prod path), then `DEFAULT_COPILOT_MODEL` (floor — used before the
// probe runs / if it was inconclusive). Module-level so the 6 deciders' existing sync
// `resolveCopilotModel()` calls pick it up with no per-decider change.
let resolvedLaunchModel: string | null = null;

/** Record the model the startup probe resolved (ORCH-28). Pass null to clear (tests). */
export function setResolvedLaunchModel(model: string | null): void {
  resolvedLaunchModel = model && model.trim().length > 0 ? model : null;
}

export function resolveCopilotModel(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KB_COPILOT_MODEL;
  if (override && override.trim().length > 0) return override; // eval harness override wins
  return resolvedLaunchModel ?? DEFAULT_COPILOT_MODEL; // probed model, else the interim floor
}

/** The resilience fallback model. `copilot --model auto` lets Copilot pick from its own catalog;
 *  verified accepted by the CLI (0.0.373, `--help`: "use 'auto' to let Copilot pick automatically").
 *  If a PINNED id is ever rejected pre-flight, falling back to `auto` restores the unpinned-but-working
 *  behavior prod had before #340 — so a model-id drift can never hard-break the whole pipeline. */
export const COPILOT_MODEL_AUTO = 'auto';

/**
 * True when `err` is Copilot's PRE-FLIGHT model-rejection — the failure mode that makes a stale
 * pinned id (e.g. `claude-opus-4`) throw on every launch and kill the pipeline. Copilot reports it as
 * `Error: Model "X" from --model flag is not available.` on stderr; execFile rejects with that on
 * `err.message` and/or `err.stderr`. Matched narrowly so a genuine model/content error (auth, network,
 * a bad JSON parse downstream) does NOT trigger the auto-fallback — only an unavailable-model rejection.
 */
export function isModelUnavailableError(err: unknown): boolean {
  if (err == null) return false;
  const parts: string[] = [];
  if (err instanceof Error && typeof err.message === 'string') parts.push(err.message);
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') parts.push(stderr);
  const hay = parts.join('\n');
  if (!hay) return false;
  // The canonical phrasing, plus a tolerant variant in case the CLI wording shifts ("model ... not available").
  return /from --model flag is not available/i.test(hay) || /\bmodel\b[^\n]*\bis not available\b/i.test(hay) || /\bmodel\b[^\n]*\bnot available\b/i.test(hay);
}
