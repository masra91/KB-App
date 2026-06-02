// SPEC-0026 ASK-4/ASK-12 + SPEC-0030 BUG #65 — the recall skill + the Copilot-SDK client adapter.
// The SDK is mocked so we can assert the adapter's wiring (esp. that the BYOA `cliPath` reaches the
// CopilotClient connection) without spawning the CLI.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ ctorArgs: [] as unknown[], forStdioArgs: [] as unknown[] }));

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    constructor(opts?: unknown) {
      sdk.ctorArgs.push(opts);
    }
    async createSession(): Promise<{ sendAndWait: () => Promise<unknown>; disconnect: () => Promise<void> }> {
      return { sendAndWait: async () => ({}), disconnect: async () => {} };
    }
    async stop(): Promise<void> {}
  },
  RuntimeConnection: {
    forStdio: (o: unknown) => {
      sdk.forStdioArgs.push(o);
      return { kind: 'stdio', ...(o as object) };
    },
  },
  defineTool: (name: string, cfg: Record<string, unknown>) => ({ name, ...cfg }),
  approveAll: {},
}));

import { RECALL_SKILL, RECALL_SKILL_VERSION, makeSdkRecallClient } from './recallAgent';

beforeEach(() => {
  sdk.ctorArgs.length = 0;
  sdk.forStdioArgs.length = 0;
});

describe('recall skill (ASK-4)', () => {
  it('teaches KB structure, grounding, and the submitAnswer finish protocol', () => {
    expect(RECALL_SKILL).toContain('KB-App Recall agent');
    expect(RECALL_SKILL).toContain('KB STRUCTURE');
    expect(RECALL_SKILL).toContain('GROUNDING');
    expect(RECALL_SKILL).toContain('submitAnswer');
    expect(RECALL_SKILL).toMatch(/tags/); // metadata-aware (SPEC-0025 META)
    expect(RECALL_SKILL).toMatch(/STOP calling tools/); // budget stop-criterion (dogfood #5)
    expect(RECALL_SKILL_VERSION).toBe('recall/v3-sdk');
  });
});

describe('makeSdkRecallClient (ASK-12 substrate + BUG #65 cliPath)', () => {
  it('returns a RecallClient seam without spawning the CLI (lazy)', () => {
    const client = makeSdkRecallClient({ model: 'gpt-5' });
    expect(typeof client.createSession).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(sdk.ctorArgs).toHaveLength(0); // no CopilotClient constructed until createSession
  });

  it('wires the BYOA cliPath into the SDK connection (BUG #65 — recall works in the packaged app)', async () => {
    const client = makeSdkRecallClient({ cliPath: '/abs/path/copilot' });
    await client.createSession({ tools: [], systemMessage: { mode: 'append', content: 'x' }, allowedTools: [] });
    expect(sdk.forStdioArgs).toContainEqual({ path: '/abs/path/copilot' });
    expect(sdk.ctorArgs[0]).toMatchObject({ connection: { kind: 'stdio', path: '/abs/path/copilot' } });
  });

  it('constructs the client with no connection when cliPath is absent (SDK default search)', async () => {
    const client = makeSdkRecallClient({});
    await client.createSession({ tools: [] });
    expect(sdk.forStdioArgs).toHaveLength(0);
    expect(sdk.ctorArgs[0]).toEqual({});
  });
});
