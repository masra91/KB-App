// The WorkIQ/M365 MCP contract (SPEC-0028 Slice 3 · WORKIQ-FIX) — the read-only stdio MCP launch + its
// per-surface read-tool allow-list. Pure module: asserted with no SDK, no spawning. The key guards are
// (1) READ-ONLY: only search/read tools are ever allow-listed — no send/write/delete leaks in; and
// (2) the launch is deterministic + tenant-scoped.
import { describe, it, expect } from 'vitest';
import {
  WORKIQ_CLI_NAME,
  WORKIQ_INSTALL_COMMAND,
  WORKIQ_INSTALL_ARGV,
  WORKIQ_READ_TOOLS_BY_SURFACE,
  workIqMcpArgs,
  workIqReadTools,
  buildWorkIqMcpServer,
} from './workiqMcp';

describe('workIqMcpArgs — read-only, tenant-scoped, deterministic launch', () => {
  it('builds `mcp --read-only --tenant … --surfaces …` with surfaces sorted (stable spawn)', () => {
    expect(workIqMcpArgs('contoso.onmicrosoft.com', ['teams', 'mail'])).toEqual([
      'mcp',
      '--read-only',
      '--tenant',
      'contoso.onmicrosoft.com',
      '--surfaces',
      'mail,teams', // sorted regardless of input order
    ]);
  });
  it('always carries --read-only (the enforceable posture, not just the prompt)', () => {
    expect(workIqMcpArgs('t', ['mail'])).toContain('--read-only');
  });
});

describe('workIqReadTools — only read/search tools, deduped + order-stable', () => {
  it('unions the requested surfaces and never emits a write/send/delete tool', () => {
    const tools = workIqReadTools(['mail', 'calendar', 'sharepoint', 'teams']);
    // Every tool is a search_/read_ tool — no mutate verb leaks into the allow-list.
    for (const t of tools) expect(t).toMatch(/_(search|read)_/);
    for (const t of tools) expect(t).not.toMatch(/send|post|create|update|move|delete|write/);
    // Covers all four surfaces' read tools.
    expect(tools).toEqual(expect.arrayContaining([...WORKIQ_READ_TOOLS_BY_SURFACE.mail, ...WORKIQ_READ_TOOLS_BY_SURFACE.teams]));
  });
  it('dedups across surfaces and returns [] for an empty surface list (conservative default)', () => {
    expect(workIqReadTools([])).toEqual([]);
    const once = workIqReadTools(['mail', 'mail']);
    expect(new Set(once).size).toBe(once.length);
  });
  it('only the requested surface contributes tools (a calendar-only researcher gets no mail tools)', () => {
    expect(workIqReadTools(['calendar'])).toEqual([...WORKIQ_READ_TOOLS_BY_SURFACE.calendar]);
  });
});

describe('buildWorkIqMcpServer — the injected mcpServer result', () => {
  it('returns a stdio server on the resolved cliPath + the matching read tools', () => {
    const { server, readTools } = buildWorkIqMcpServer('/opt/homebrew/bin/workiq', 'contoso', ['mail', 'calendar']);
    expect(server).toEqual({
      type: 'stdio',
      command: '/opt/homebrew/bin/workiq',
      args: ['mcp', '--read-only', '--tenant', 'contoso', '--surfaces', 'calendar,mail'],
    });
    expect(readTools).toEqual(workIqReadTools(['mail', 'calendar']));
  });
});

describe('install + CLI constants', () => {
  it('the install ARGV matches the human-readable command string', () => {
    const [cmd, args] = WORKIQ_INSTALL_ARGV;
    expect(`${cmd} ${args.join(' ')}`).toBe(WORKIQ_INSTALL_COMMAND);
  });
  it('the CLI name is the bare `workiq` binary (resolved on PATH like copilot)', () => {
    expect(WORKIQ_CLI_NAME).toBe('workiq');
  });
});
