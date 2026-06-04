// Regression (#209 follow-up): the live research session must pass a GENEROUS stuck-backstop timeout
// to the SDK's `sendAndWait`, not silently fall back to the SDK's 60s default.
//
// Why this bug bit: #209 raised the default budget 8 → 15 tool calls and rewrote the skill to read
// "several sources in depth" — a deep multi-fetch pass routinely runs > 60s, so the 60s default
// false-failed real runs as `research.session-failed: Timeout after 60000ms waiting for session.idle`.
// The timeout is a stuck-session backstop (the agent bills tokens/tools via `maxToolCalls`, never wall
// time), so it must be generous. This pins that the wiring actually passes our timeout to the session.
//
// We mock the SDK at its dynamic-import seam (the rest of the suite uses injected sessions; the live
// session is otherwise CI/e2e-only) purely to capture the `sendAndWait(prompt, timeout)` arguments.
import { describe, it, expect, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  sendAndWait: vi.fn(async (_prompt?: string, _timeout?: number): Promise<void> => undefined),
}));

vi.mock('@github/copilot-sdk', () => {
  class CopilotClient {
    async createSession(): Promise<{ sendAndWait: typeof sdk.sendAndWait; disconnect: () => Promise<void> }> {
      return { sendAndWait: sdk.sendAndWait, disconnect: async () => {} };
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

import { makeWebResearchFn } from './researchWebAgent';
import { DEFAULT_RESEARCH_SESSION_TIMEOUT_MS } from './researchers';
import type { ResearcherConfig, ResearchRequest } from './researchers';

const web = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({
  id: 'web-1', template: 'web', prompt: 'find prior art', egressTier: 'public-web', scope: 'global',
  budget: { maxToolCalls: 15, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true, ...over,
});
const req: ResearchRequest = { id: 'r1', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose' }, what: 'Project Atlas', why: 'unknown', context: 'launch', dedupKey: 'k' };

describe('research session timeout — stuck-backstop, not the SDK 60s default (#209 regression)', () => {
  it('passes a generous timeout (>> 60s) to the live web session sendAndWait', async () => {
    const fn = makeWebResearchFn({}); // no injected session → liveSdkSession → the mocked SDK
    await fn(web(), req);

    expect(sdk.sendAndWait).toHaveBeenCalledTimes(1);
    const [, timeout] = sdk.sendAndWait.mock.calls[0];
    // The fix: our generous backstop is passed explicitly — NOT undefined (which = the SDK 60s default).
    expect(timeout).toBe(DEFAULT_RESEARCH_SESSION_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(60_000);
  });

  it('the default backstop is many minutes, so a deep multi-fetch pass never false-fails', () => {
    expect(DEFAULT_RESEARCH_SESSION_TIMEOUT_MS).toBe(15 * 60_000);
  });
});
