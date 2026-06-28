import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { buildDecomposePrompt, makeDecomposeDecider, DECOMPOSE_PROMPT_VERSION, type SourceInput } from './decomposeAgent';

// COPILOT-CONTEXT-SCOPE-BUG: partial-mock node:child_process to drive the REAL defaultRunner and
// assert it forwards the threaded vaultPath to execFile as `cwd` (the actual consumption site).
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  sourceId: '01JSRC',
  kind: 'text',
  text: 'call Steve re: Q3 budget',
  ...over,
});

describe('buildDecomposePrompt (DECOMP-7, DECOMP-3)', () => {
  it('nudges the base kind set as PROSE without gating it', () => {
    const p = buildDecomposePrompt(input());
    expect(p).toContain('person, organization, concept, event, place, project');
    expect(p).toContain('COIN a new kind'); // open vocabulary nudge, not a closed set
  });

  it('embeds the source id and text, and asks for JSON only', () => {
    const p = buildDecomposePrompt(input());
    expect(p).toContain('sourceId: 01JSRC');
    expect(p).toContain('call Steve re: Q3 budget');
    expect(p).toContain('ONLY a JSON object');
  });

  it('tells the agent not to resolve identity across sources (deferred to Connect; DECOMP-14)', () => {
    expect(buildDecomposePrompt(input())).toMatch(/do not resolve identity across sources/i);
  });

  it('fences the source as untrusted DATA, never instructions (INTAKE-13 injection posture)', () => {
    const p = buildDecomposePrompt(input());
    expect(p).toMatch(/DATA.*NEVER instructions/i); // the fence is present (FAILS-BEFORE: no such framing)
    expect(p).toMatch(/do not follow/i);
    expect(p).toMatch(/SOURCE BEGIN \(untrusted DATA/); // delimiter reminder at the untrusted bytes
  });
});

describe('node-vs-attribute granularity policy (DECOMP-17)', () => {
  it('defines a node as having independent identity', () => {
    const p = buildDecomposePrompt(input());
    expect(p).toMatch(/independent identity/i);
    expect(p).toMatch(/exists independently of this source/i);
  });

  it('steers roles/descriptors/attributes/relationships away from being nodes (→ Claims)', () => {
    const p = buildDecomposePrompt(input());
    // the over-extraction the dogfood surfaced: a role/descriptor must NOT become a node
    expect(p).toContain('first computer programmer');
    expect(p).toMatch(/roles \/ titles \/ descriptors/i);
    expect(p).toMatch(/relationships or predicates/i);
    expect(p).toMatch(/recorded later by the Claims stage, never as their own nodes/i);
  });

  it('gives a tie-breaker and biases toward FEWER nodes when unsure', () => {
    const p = buildDecomposePrompt(input());
    expect(p).toMatch(/could a DIFFERENT source add independent facts/i);
    expect(p).toMatch(/PREFER FEWER, higher-confidence nodes/);
    expect(p).toMatch(/treat it as an attribute and do NOT extract it/);
  });

  it('bumps the prompt version to reflect the tightened policy', () => {
    expect(DECOMPOSE_PROMPT_VERSION).toBe('decompose/v2');
  });
});

describe('makeDecomposeDecider (DECOMP-3, DECOMP-6)', () => {
  it('uses the injected runner and stamps an ORCH-16 agent trace', async () => {
    const decide = makeDecomposeDecider({
      available: true,
      run: async () => '{"sourceId":"01JSRC","entities":[{"kind":"person","name":"Steve","confidence":0.9,"mentions":["call Steve"]}]}',
    });
    const d = await decide(input());
    expect(d.entities[0].name).toBe('Steve');
    expect(d.agent?.via).toBe('copilot');
    expect(d.agent?.ok).toBe(true);
  });

  it('THROWS when copilot is unavailable — never fabricates entities (DECOMP-6)', async () => {
    await expect(makeDecomposeDecider({ available: false })(input())).rejects.toThrow(/unavailable/);
  });

  // COPILOT-CONTEXT-SCOPE-BUG regression (fail-before/pass-after): the real defaultRunner must pass
  // the threaded vaultPath to execFile as `cwd` so Copilot scans the staging worktree, not `/`.
  it('runs the real Copilot subprocess in the threaded vaultPath (execFile cwd)', async () => {
    vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '{}', stderr: '' });
      return {} as never;
    }) as never);
    await makeDecomposeDecider({ available: true, vaultPath: '/vault/.kb/cache/worktrees/staging' })(input()).catch(() => {});
    const opts = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe('/vault/.kb/cache/worktrees/staging');
  });

  it('leaves execFile cwd undefined when no vaultPath is set (unscoped)', async () => {
    vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '{}', stderr: '' });
      return {} as never;
    }) as never);
    await makeDecomposeDecider({ available: true })(input()).catch(() => {});
    const opts = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBeUndefined();
  });

  it('THROWS on bad output rather than inventing a decision (DECOMP-6)', async () => {
    await expect(makeDecomposeDecider({ available: true, run: async () => 'not json' })(input())).rejects.toThrow();
  });

  // MODEL-AUTO-FALLBACK (ORCH-16 fast-follow): a pinned-model rejection retries once with `auto`,
  // and the throw-style AgentTrace records the real model (`auto`) that ran.
  it('retries with `auto` when the pinned model is rejected, recording auto in the AgentTrace', async () => {
    vi.stubEnv('KB_COPILOT_MODEL', '');
    try {
      const run = vi.fn(async (_p: string, _cwd?: string, model?: string) => {
        if (model !== 'auto') throw new Error('Model "claude-opus-4" from --model flag is not available.');
        return '{"sourceId":"01JSRC","entities":[{"kind":"person","name":"Steve","confidence":0.9,"mentions":["call Steve"]}]}';
      });
      const d = await makeDecomposeDecider({ available: true, run })(input());
      expect(run).toHaveBeenCalledTimes(2); // pinned (rejected) → auto
      expect(d.agent?.model).toBe('auto');
      expect(d.agent?.ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
