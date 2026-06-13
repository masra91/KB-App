// Shared Copilot launch resilience (model-pin fast-follow for ORCH-16 / the #340 class).
//
// #340 pins the Copilot model in-app so prod always launches with a concrete `--model`. But copilot
// validates `--model` PRE-FLIGHT and HARD-REJECTS an unknown id (`Model "X" … not available`) — so if a
// pinned id ever stops being valid (a catalog change, a typo, a CLI upgrade), EVERY decider launch would
// throw and the whole pipeline would die — strictly worse than the unpinned-but-working state prod had
// before #340. (`claude-opus-4` was exactly such an invalid pin, caught pre-merge on #340.)
//
// This helper makes the pin RESILIENT: attempt with the pinned model; if — and ONLY if — copilot rejects
// it as unavailable, retry ONCE with `--model auto` (Copilot picks from its own catalog; CLI-verified
// accepted). Any other error (auth, network, a per-item content failure) propagates unchanged — we do NOT
// mask real failures behind a model swap. The single retry is the resilience floor, not a retry loop.
import { resolveCopilotModel, isModelUnavailableError, COPILOT_MODEL_AUTO } from './copilotModel';

/**
 * Run a Copilot `attempt` with the pinned model, falling back to `--model auto` exactly once if the CLI
 * rejects the pinned model as unavailable. `attempt(model)` performs the actual launch with the given
 * model id and resolves to the session's result; it is invoked at most twice (pinned, then `auto`).
 *
 * `onFallback(from, to)` fires only when the fallback is taken — callers use it to record the real model
 * that ran in the trace (so a silent pin-drift is visible, not hidden). `env` is injectable for tests.
 */
export async function runWithModelFallback<T>(
  attempt: (model: string) => Promise<T>,
  opts: { env?: NodeJS.ProcessEnv; onFallback?: (from: string, to: string) => void } = {},
): Promise<T> {
  const pinned = resolveCopilotModel(opts.env);
  try {
    return await attempt(pinned);
  } catch (err) {
    // Only an unavailable-model rejection is recoverable by swapping the model — everything else is a
    // real failure the caller must see (a content/auth/network error retried on `auto` would just fail
    // again and hide the cause).
    if (!isModelUnavailableError(err)) throw err;
    opts.onFallback?.(pinned, COPILOT_MODEL_AUTO);
    return attempt(COPILOT_MODEL_AUTO);
  }
}
