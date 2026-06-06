// Researcher cognition wiring (SPEC-0028 / #160 / BUG #65 class) — the SINGLE place the main process
// resolves the BYOA `copilot` CLI path and builds the research `DispatchDeps` options. Both researcher
// entry points (the scheduler tick AND the Control-Panel "Run now") go through here, so the packaged
// app's stripped PATH can't leave the SDK unable to spawn copilot at one call site while the other is
// fixed — the bug class can't reopen at a second seam.
//
// Layering (STACK-6): `resolveExecutable` is main-tier (it shells out to the login shell); the kb-tier
// research adapter takes the resolved `cliPath` as data. This module is the only bridge.
import { resolveExecutable } from './resolvePath';
import type { WebResearchOptions } from '../kb/researchWebAgent';
import type { CodeResearchOptions } from '../kb/researchCodeAgent';
import type { ResearchDepsOptions } from '../kb/researchInline';
import type { DevLog } from '../kb/devlog';

/**
 * The BYOA `copilot` path for the Copilot SDK's `cliPath` (BUG #65) — resolved on the user's login-shell
 * PATH so a GUI/packaged launch (stripped PATH) still finds it. `undefined` (not `null`) when absent,
 * so it slots straight into the SDK's "no path → default search" branch (dev fallback).
 */
export function resolveCopilotCliPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  return resolveExecutable('copilot', env, platform) ?? undefined;
}

/** Web-researcher SDK options with the resolved cliPath + the research dev-log (#160: failed ≠ empty). */
export function webResearchOptions(log: DevLog): WebResearchOptions {
  return { cliPath: resolveCopilotCliPath(), log };
}

/** Code-researcher SDK options (RESEARCH-20): the resolved cliPath enables the live agentic local-repo
 *  session; absent → the deterministic grep fallback (RESEARCH-14). The dev-log surfaces a session
 *  failure before it degrades to grep (#160: never silent). */
export function codeResearchOptions(log: DevLog): CodeResearchOptions {
  return { cliPath: resolveCopilotCliPath(), log };
}

/**
 * The research `DispatchDeps` options the scheduler + Run-now share — wires the resolved copilot
 * cliPath (so the SDK starts in the packaged app) and the dev-log (so a failure is logged, not
 * swallowed) into the Web + Code adapters behind the `ResearchFn` seam.
 */
export function researchDepsOptions(log: DevLog): ResearchDepsOptions {
  return { web: webResearchOptions(log), code: codeResearchOptions(log) };
}
