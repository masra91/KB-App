// INTAKE-7 read-only HARD gate (SPEC-0041 Slice 2) — the enforceable guard, not the soft skill text.
// The live mail session must expose ONLY the Graph MCP's read tools + the submitMessages sink in
// `availableTools`; no send/reply/forward/mark-read/move/delete tool may ever be available, so a poll
// can't mutate the mailbox. We mock the SDK at its dynamic-import seam (the rest of the connector suite
// uses an injected `session`; the live path is otherwise env-gated) purely to capture the SessionConfig
// `createSession` is called with. Mirrors researchSessionTimeout.test.ts's mock pattern.
import { describe, it, expect, vi } from 'vitest';

const cap = vi.hoisted(() => ({ config: null as unknown }));

vi.mock('@github/copilot-sdk', () => {
  class CopilotClient {
    async createSession(config: unknown): Promise<{ sendAndWait: () => Promise<void>; disconnect: () => Promise<void> }> {
      cap.config = config; // capture the session config (carries availableTools)
      return { sendAndWait: async () => undefined, disconnect: async () => {} };
    }
    async stop(): Promise<void> {}
  }
  return {
    CopilotClient,
    RuntimeConnection: { forStdio: (): unknown => ({}) },
    defineTool: (name: string, def: unknown): unknown => ({ name, def }),
    approveAll: (): void => {},
  };
});

import { makeM365MailIntakeFn, SUBMIT_MESSAGES_TOOL } from './m365MailConnector';
import type { IntakeConnectorConfig } from './intakeConnectors';
import type { MCPServerConfig } from '@github/copilot-sdk';

const conn = (): IntakeConnectorConfig => ({
  id: 'work-mail', type: 'm365-mail', schedule: 'hourly', enabled: true, scope: 'work', sensitivity: 'confidential',
  config: { tenantId: 'tenant-abc' },
});

describe('M365 mail intake — read-only allow-list (INTAKE-7 hard gate)', () => {
  it('exposes ONLY the MCP read tools + submitMessages — no send/mark-read/move/delete', async () => {
    // Live path: no injected session + an mcpServer wired → liveMailSession → the mocked SDK.
    const fn = makeM365MailIntakeFn({
      cliPath: '/x/copilot',
      mcpServer: () => ({ server: {} as MCPServerConfig, readTools: ['mail_list', 'mail_read'] }),
    });
    await fn(conn(), { maxItems: 25 });

    const config = cap.config as { availableTools?: string[]; mcpServers?: Record<string, unknown> };
    // The enforceable gate: exactly the read tools + the findings sink, nothing else.
    expect(config.availableTools).toEqual(['mail_list', 'mail_read', SUBMIT_MESSAGES_TOOL]);
    // And explicitly: no mutating mail tool can have slipped in.
    const forbidden = /send|reply|forward|mark|move|delete|create|update|draft/i;
    expect((config.availableTools ?? []).some((t) => forbidden.test(t))).toBe(false);
    // The Graph MCP is registered (scoped to the tenant by its OAuth, in main).
    expect(config.mcpServers).toHaveProperty('m365');
  });
});
