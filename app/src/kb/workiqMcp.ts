// The WorkIQ/M365 MCP contract (SPEC-0028 Slice 3 · WORKIQ-FIX) — the SINGLE place the WorkIQ CLI's
// name, its read-only stdio MCP launch, its per-surface read-tool allow-list, and its install command
// live. The M365 researcher (`researchM365Agent`) and the M365-mail intake connector (`m365MailConnector`)
// both reach the user's OWN Microsoft 365 tenant through a read-only Graph MCP server; rather than each
// env-wire a bespoke server, they take an injected `mcpServer` factory. This module BUILDS that factory
// from the resolved `workiq` CLI path: the CLI is launched as a stdio MCP server (`workiq mcp …`), scoped
// to the tenant + the requested read surfaces, and ONLY its READ tools (plus the caller's own findings/
// messages sink) are allow-listed — never a send/write/delete tool (the read-only egress gate, RESEARCH-10).
//
// Why this module is the bug fix: `researchWiring.researchDepsOptions` returned `{web, code}` and never
// built `opts.m365`, so `makeM365ResearchFn(undefined)` had no `mcpServer` and silently returned a
// no-finding — "looks alive, does nothing". This module gives `researchWiring` a real factory to inject
// (when the CLI is installed) so the researcher's worktree agent actually gets a live MCP.
//
// Concrete-at-env-time boundary (matches the rest of this M365 slice — see the "chosen at env-time"
// notes in researchM365Agent/m365MailConnector): the exact WorkIQ npm package and the MCP tool NAMES
// finalize when the real CLI lands. They are named HERE (not scattered across call sites) so that final
// wiring is a one-file edit. Pure module — the SDK type is imported type-only (erased at compile), so it
// stays unit-testable with no SDK, no network, no spawning.
import type { MCPServerConfig } from '@github/copilot-sdk';
import type { M365Surface } from './researchM365Agent';

/** The BYOA WorkIQ CLI binary name — resolved on the (STACK-9-ensured) PATH like `copilot`/`gh`/`git`. */
export const WORKIQ_CLI_NAME = 'workiq';

/** The CLI subcommand that starts the read-only Graph MCP server over stdio. */
export const WORKIQ_MCP_SUBCOMMAND = 'mcp';

/**
 * The read-tool allow-list the WorkIQ MCP exposes PER M365 surface. Only read/search tools — no send,
 * post, create, move, or delete tool ever appears here, so the agent physically cannot mutate the
 * tenant (the enforceable read-only gate, not the soft prompt). The concrete tool names finalize at
 * env-time with the real CLI; centralized here so that's a single edit.
 */
export const WORKIQ_READ_TOOLS_BY_SURFACE: Record<M365Surface, readonly string[]> = {
  mail: ['workiq_search_mail', 'workiq_read_mail'],
  calendar: ['workiq_search_calendar', 'workiq_read_event'],
  sharepoint: ['workiq_search_sharepoint', 'workiq_read_document'],
  teams: ['workiq_search_teams', 'workiq_read_message'],
};

/** The stdio MCP launch args: read-only, scoped to the tenant + the requested surfaces (surfaces sorted
 *  so the spawned command is deterministic). */
export function workIqMcpArgs(tenantId: string, surfaces: readonly M365Surface[]): string[] {
  return [WORKIQ_MCP_SUBCOMMAND, '--read-only', '--tenant', tenantId, '--surfaces', [...surfaces].sort().join(',')];
}

/** The union of read tools across the requested surfaces (deduped, order-stable). An empty/unknown
 *  surface list yields no tools — the caller still allow-lists its own sink, so the agent has no MCP read
 *  power, which is the correct conservative default. */
export function workIqReadTools(surfaces: readonly M365Surface[]): string[] {
  const out: string[] = [];
  for (const s of surfaces) {
    for (const t of WORKIQ_READ_TOOLS_BY_SURFACE[s] ?? []) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Build the injected `mcpServer` result for a tenant + surfaces from a resolved WorkIQ CLI path: a stdio
 * MCP server (`workiq mcp --read-only --tenant … --surfaces …`) plus its read-tool allow-list. This is the
 * shape both `M365ResearchOptions.mcpServer` and `M365MailIntakeOptions.mcpServer` expect; the call sites
 * in `researchWiring` close over `cliPath` and adapt the input shape (research passes surfaces; mail uses
 * `['mail']`).
 */
export function buildWorkIqMcpServer(
  cliPath: string,
  tenantId: string,
  surfaces: readonly M365Surface[],
): { server: MCPServerConfig; readTools: string[] } {
  const server: MCPServerConfig = {
    type: 'stdio',
    command: cliPath,
    args: workIqMcpArgs(tenantId, surfaces),
  };
  return { server, readTools: workIqReadTools(surfaces) };
}

/** The install command shown on the setup card + run by its Install button ("simple workiq via CLI",
 *  Principal-verbatim). `WORKIQ_INSTALL_ARGV` is the execFile-ready split; `WORKIQ_INSTALL_COMMAND` is the
 *  human-readable string. The concrete package finalizes at env-time with the real CLI — kept here as the
 *  single source of truth. */
export const WORKIQ_INSTALL_ARGV: readonly [string, readonly string[]] = ['npm', ['install', '-g', '@workiq/cli']];
export const WORKIQ_INSTALL_COMMAND = 'npm install -g @workiq/cli';
