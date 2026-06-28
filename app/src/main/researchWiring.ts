// Researcher cognition wiring (SPEC-0028 / #160 / BUG #65 class) — the SINGLE place the main process
// resolves the BYOA `copilot` CLI path and builds the research `DispatchDeps` options. Both researcher
// entry points (the scheduler tick AND the Control-Panel "Run now") go through here, so the packaged
// app's stripped PATH can't leave the SDK unable to spawn copilot at one call site while the other is
// fixed — the bug class can't reopen at a second seam.
//
// Layering (STACK-6): `resolveExecutable` is main-tier (it shells out to the login shell); the kb-tier
// research adapter takes the resolved `cliPath` as data. This module is the only bridge.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveExecutable } from './resolvePath';
import { resolveCopilotModel } from '../kb/copilotModel';
import { buildWorkIqMcpServer, WORKIQ_CLI_NAME, WORKIQ_INSTALL_ARGV, WORKIQ_INSTALL_COMMAND } from '../kb/workiqMcp';
import type { WebResearchOptions } from '../kb/researchWebAgent';
import type { CodeResearchOptions } from '../kb/researchCodeAgent';
import type { M365ResearchOptions, M365Surface } from '../kb/researchM365Agent';
import type { M365MailIntakeOptions } from '../kb/m365MailConnector';
import type { MediaExtractOptions } from '../kb/mediaExtract';
import type { ResearchDepsOptions } from '../kb/researchInline';
import type { IntakeDepsOptions } from '../kb/intakeScheduler';
import type { WorkIqStatus, InstallWorkIqResult } from '../kb/types';
import type { DevLog } from '../kb/devlog';

const execFileAsync = promisify(execFile);

/**
 * The BYOA `copilot` path for the Copilot SDK's `cliPath` (BUG #65) — resolved on the user's login-shell
 * PATH so a GUI/packaged launch (stripped PATH) still finds it. `undefined` (not `null`) when absent,
 * so it slots straight into the SDK's "no path → default search" branch (dev fallback).
 */
export function resolveCopilotCliPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  return resolveExecutable('copilot', env, platform) ?? undefined;
}

/** Web-researcher SDK options with the resolved cliPath + the research dev-log (#160: failed ≠ empty).
 *  SPEC-0048 WS-D(c): pin the model the SDK session runs on (researchers otherwise passed no model →
 *  the SDK inherited `~/.copilot/settings.json`, the same model-pin gap #340 closed for the deciders).
 *  `resolveCopilotModel(undefined, 'researcher-web')` = the per-researcher pin if set, else the global. */
export function webResearchOptions(log: DevLog): WebResearchOptions {
  return { cliPath: resolveCopilotCliPath(), log, model: resolveCopilotModel(undefined, 'researcher-web') };
}

/** Code-researcher SDK options (RESEARCH-20): the resolved cliPath enables the live agentic local-repo
 *  session; absent → the deterministic grep fallback (RESEARCH-14). The dev-log surfaces a session
 *  failure before it degrades to grep (#160: never silent). SPEC-0048 WS-D(c): pin the model (per-agent
 *  'researcher-code' → global), so the agentic pass runs the chosen model, not settings.json's. */
export function codeResearchOptions(log: DevLog): CodeResearchOptions {
  return { cliPath: resolveCopilotCliPath(), log, model: resolveCopilotModel(undefined, 'researcher-code') };
}

/**
 * The BYOA `workiq` CLI path (the WorkIQ/M365 researcher's read-only Graph MCP server). Resolved on the
 * (STACK-9-ensured) login-shell PATH exactly like `copilot`, so a GUI/packaged launch still finds it.
 * `undefined` when absent — the caller then omits the `mcpServer` factory, and a configured-tenant m365
 * researcher FAILS LOUD (research-failed "needs-setup") rather than the old silent no-finding. WORKIQ-FIX.
 */
export function resolveWorkIqCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  return resolveExecutable(WORKIQ_CLI_NAME, env, platform) ?? undefined;
}

/** M365/WorkIQ researcher SDK options (SPEC-0028 Slice 3) — the resolved copilot cliPath + pinned model
 *  (researcher-m365 → global, like web/code), and the read-only WorkIQ Graph MCP factory **only when the
 *  CLI is installed**. Absent factory ⇒ the adapter fails loud (needs-setup), never silent (WORKIQ-FIX).
 *  This is the wiring whose absence made WorkIQ "do nothing": `opts.m365` was never built. */
export function m365ResearchOptions(): M365ResearchOptions {
  const workiq = resolveWorkIqCli();
  return {
    cliPath: resolveCopilotCliPath(),
    model: resolveCopilotModel(undefined, 'researcher-m365'),
    ...(workiq
      ? { mcpServer: ({ tenantId, surfaces }: { tenantId: string; surfaces: M365Surface[] }) => buildWorkIqMcpServer(workiq, tenantId, surfaces) }
      : {}),
  };
}

/** M365-mail INTAKE connector options (SPEC-0041 Slice 2) — same WorkIQ MCP factory, scoped to the mail
 *  surface. Wired so the intake scheduler's m365-mail connector reaches the tenant instead of the dead
 *  `intakeScheduler.ts:66` `{}` (its un-wired `makeM365MailIntakeFn` THROWS → `intake-failed`, fail-loud). */
export function m365MailIntakeOptions(): M365MailIntakeOptions {
  const workiq = resolveWorkIqCli();
  return {
    cliPath: resolveCopilotCliPath(),
    model: resolveCopilotModel(undefined, 'researcher-m365'),
    ...(workiq ? { mcpServer: ({ tenantId }: { tenantId: string }) => buildWorkIqMcpServer(workiq, tenantId, ['mail']) } : {}),
  };
}

/**
 * The research `DispatchDeps` options the scheduler + Run-now share — wires the resolved copilot
 * cliPath (so the SDK starts in the packaged app) and the dev-log (so a failure is logged, not
 * swallowed) into the Web + Code adapters behind the `ResearchFn` seam, plus the M365/WorkIQ adapter
 * (WORKIQ-FIX: `m365` was the missing third arm — its absence is why the researcher silently no-op'd).
 */
export function researchDepsOptions(log: DevLog): ResearchDepsOptions {
  return { web: webResearchOptions(log), code: codeResearchOptions(log), m365: m365ResearchOptions() };
}

/** SPEC-0052 MEDIA: the archive-stage media-extraction options — the resolved copilot cliPath + pinned
 *  model (the archivist's), so the orchestrator can extract a text body from a dropped PDF/image via the
 *  Copilot multimodal path in the packaged app. Vision capability is probed at run-time (`liveVisionProbe`);
 *  absent a vision model the extraction fails loud (needs-setup), never a silent empty body. */
export function mediaExtractOptions(): MediaExtractOptions {
  return { cliPath: resolveCopilotCliPath(), model: resolveCopilotModel(undefined, 'archivist') };
}

/** The INTAKE scheduler's deps — wires the M365-mail connector's WorkIQ MCP factory so the proactive
 *  m365-mail pull reaches the tenant (was `{}` at the scheduler construction, INTAKE silently dead). */
export function intakeDepsOptions(): IntakeDepsOptions {
  return { m365Mail: m365MailIntakeOptions() };
}

/** WorkIQ/M365 CLI setup status for the Sources/Researchers card (WORKIQ-FIX): is the `workiq` CLI on
 *  PATH? Plus the install command the card surfaces. The researcher fails loud until `installed` is true. */
export function workIqStatus(): WorkIqStatus {
  const cliPath = resolveWorkIqCli();
  return { installed: cliPath !== undefined, ...(cliPath ? { cliPath } : {}), installCommand: WORKIQ_INSTALL_COMMAND };
}

/** Injectable install runner (tests pass a fake; production shells out the global install). */
export type InstallRunner = (command: string, args: readonly string[]) => Promise<void>;

const defaultInstallRunner: InstallRunner = async (command, args) => {
  // Global CLI install can take a while; generous timeout + a real buffer. The child inherits the
  // STACK-9-ensured PATH so npm + its global bin resolve in the packaged app.
  await execFileAsync(command, [...args], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
};

/**
 * Run the WorkIQ install command from the setup card, then RE-DETECT (so the card flips to "ready"
 * without a second round-trip). A spawn error / non-zero exit ⇒ `ok:false` + the cause; an install that
 * "succeeds" but leaves the CLI off PATH ⇒ `ok:false` with a clear message (don't lie that it worked).
 * The runner is injected so the whole flow is unit-tested without spawning anything (WORKIQ-FIX).
 */
export async function installWorkIq(runner: InstallRunner = defaultInstallRunner): Promise<InstallWorkIqResult> {
  const [command, args] = WORKIQ_INSTALL_ARGV;
  try {
    await runner(command, args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: workIqStatus() };
  }
  const status = workIqStatus();
  if (!status.installed) {
    return { ok: false, error: `install ran but \`${WORKIQ_CLI_NAME}\` is still not on PATH`, status };
  }
  return { ok: true, status };
}
