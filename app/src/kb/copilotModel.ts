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

// SPEC-0048 per-agent override: the Principal's explicit per-agent model picks (Agents-view per-agent
// picker → instance.json `agentModels`), keyed by AGENT_CATALOG key. Validated at set-time/startup, so
// only catalog-accepted ids reach here. Wins over the GLOBAL resolved model for that agent only; an
// agent with no entry falls through to the global resolution. Module-level so a decider that passes its
// `agentKey` to `resolveCopilotModel` picks up its own pin.
let agentModelOverrides: Record<string, string> = {};

/** Record the validated per-agent model overrides (SPEC-0048). Replaces the whole map; empty clears. */
export function setAgentModelOverrides(map: Record<string, string>): void {
  agentModelOverrides = { ...map };
}

// INGEST-PERF item 4 (SPEC-0048 per-stage model tiering): the right-sized DEFAULT model per stage,
// keyed by AGENT_CATALOG key. Stages reason very differently beyond the raw source (Archive normalizes,
// Decompose parses ONE source, Claims does bounded source-local extraction — all cheaper-tier-OK; Connect
// dedups/links across the whole KB, Compose/Research synthesize — strong-tier). The copilot CLI exposes
// ONLY `--model` (no effort/thinking flag — reasoning effort is model-side), so a stage's tier IS its
// model id. Resolved at startup from the SAME live-catalog probe as the global model (so a stale cheap-tier
// id degrades down to a known-good model, never bricks) and published here. Sits BELOW the Principal's
// per-agent pick (which stays the override on top) and ABOVE the global probed model — a stage with no
// entry falls through to the global default. Empty when a user GLOBAL override is active (their explicit
// wholesale choice wins over our built-in per-stage defaults).
let stageDefaultModels: Record<string, string> = {};

/** Record the per-stage DEFAULT models resolved at startup (INGEST-PERF item 4). Replaces the whole map;
 *  empty clears (e.g. a user global override is active → defer to it wholesale). */
export function setStageDefaultModels(map: Record<string, string>): void {
  stageDefaultModels = { ...map };
}

/**
 * Resolve the model to launch with. Order: eval `KB_COPILOT_MODEL` override (wins always) → the
 * per-AGENT pick for `agentKey` (Principal picker, SPEC-0048) → the per-STAGE default for `agentKey`
 * (INGEST-PERF item 4) → the GLOBAL probed/configured model (ORCH-28) → `DEFAULT_COPILOT_MODEL` floor.
 * `agentKey` (a decider's AGENT_CATALOG key) selects that agent's pin/default; omit it for the global.
 */
export function resolveCopilotModel(env: NodeJS.ProcessEnv = process.env, agentKey?: string): string {
  const override = env.KB_COPILOT_MODEL;
  if (override && override.trim().length > 0) return override; // eval harness override wins
  if (agentKey && agentModelOverrides[agentKey]) return agentModelOverrides[agentKey]; // Principal per-agent pick
  if (agentKey && stageDefaultModels[agentKey]) return stageDefaultModels[agentKey]; // per-stage right-sized default
  return resolvedLaunchModel ?? DEFAULT_COPILOT_MODEL; // global probed model, else the interim floor
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
