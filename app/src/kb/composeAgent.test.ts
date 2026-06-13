import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { buildComposePrompt, makeComposeDecider, type ComposeInput } from './composeAgent';

// COPILOT-CONTEXT-SCOPE-BUG: partial-mock node:child_process to drive the REAL defaultRunner and
// assert it forwards the threaded vaultPath to execFile as `cwd` (the actual consumption site).
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const input: ComposeInput = {
  entityId: '01JENT',
  kind: 'person',
  name: 'Steve Jobs',
  claims: [
    { statement: 'Co-founded Apple in 1976.', title: 'Apple keynote notes (2026-05-30)' },
    { statement: 'Served as CEO.', title: 'Q3 board memo (2026-05-31)' },
  ],
  links: ['Apple', 'Steve Wozniak'],
};

describe('buildComposePrompt (COMPOSE-3/4 prompt contract)', () => {
  it('presents the entity, the numbered claims, and the entities to weave as links', () => {
    const p = buildComposePrompt(input);
    expect(p).toContain('entity.name: Steve Jobs');
    expect(p).toContain('entity.kind: person');
    expect(p).toContain('[1] Co-founded Apple in 1976.');
    expect(p).toContain('[2] Served as CEO.');
    expect(p).toContain('[[Apple]]');
    expect(p).toContain('[[Steve Wozniak]]');
  });

  it('mandates grounding — claims-only + cite every sentence', () => {
    const p = buildComposePrompt(input).toLowerCase();
    expect(p).toMatch(/only.*claims|claims.*only/);
    expect(p).toMatch(/every sentence/);
    expect(p).toMatch(/grounded|grounding/);
  });

  it('tells the agent NOT to write citation markers itself (the renderer owns them)', () => {
    expect(buildComposePrompt(input).toLowerCase()).toMatch(/do not write the citation markers/);
  });
});

describe('buildComposePrompt — depth proportional to evidence (COMPOSE-10)', () => {
  it('instructs depth that scales with the evidence: fuller when rich, short when sparse, never padded', () => {
    const p = buildComposePrompt(input).toLowerCase();
    expect(p).toMatch(/scale the depth to the evidence/);
    expect(p).toMatch(/fuller,?\s+multi-section/); // many claims → a fuller, multi-section article
    expect(p).toMatch(/short but clean/); // few claims → short but clean
    expect(p).toMatch(/never pad|never.*speculate|not.*speculate/); // grounded, never padding (COMPOSE-2)
    expect(p).toMatch(/stays brief/); // a thin entity stays brief
  });

  it('presents EVERY claim, so a claim-rich entity has the material for a fuller article', () => {
    const rich: ComposeInput = {
      ...input,
      claims: Array.from({ length: 6 }, (_, i) => ({ statement: `Fact ${i + 1}.`, title: 'Src' })),
    };
    const p = buildComposePrompt(rich);
    for (let i = 1; i <= 6; i++) expect(p).toContain(`[${i}] Fact ${i}.`);
  });
});

describe('makeComposeDecider (ORCH-21 seam)', () => {
  // Prompt-faithful fake: reads how many claims the PROMPT actually lists, then returns a grounded
  // decision citing the first — so the test hinges on the prompt presenting numbered claims.
  const promptFaithfulRunner = async (prompt: string): Promise<string> => {
    const nums = [...prompt.matchAll(/^ {2}\[(\d+)\]/gm)].map((m) => Number(m[1]));
    expect(nums.length).toBeGreaterThan(0); // the prompt must present numbered claims
    return JSON.stringify({
      sections: [{ sentences: [{ text: 'Steve Jobs co-founded [[Apple]].', claims: [nums[0]] }] }],
    });
  };

  it('returns a grounded decision and stamps an AgentTrace (via copilot)', async () => {
    const decide = makeComposeDecider({ available: true, run: promptFaithfulRunner });
    const d = await decide(input);
    expect(d.entityId).toBe('01JENT');
    expect(d.sections[0].sentences[0].claims).toEqual([1]);
    expect(d.agent?.via).toBe('copilot');
    expect(d.agent?.ok).toBe(true);
  });

  it('THROWS when the agent returns un-grounded prose (an un-cited sentence) — COMPOSE-3 through the real parse path', async () => {
    const ungrounded = async () => JSON.stringify({ sections: [{ sentences: [{ text: 'No cite.', claims: [] }] }] });
    const decide = makeComposeDecider({ available: true, run: ungrounded });
    await expect(decide(input)).rejects.toThrow(/un-grounded/i);
  });

  it('THROWS when the agent cites a claim that was not offered', async () => {
    const overcite = async () => JSON.stringify({ sections: [{ sentences: [{ text: 'X.', claims: [99] }] }] });
    const decide = makeComposeDecider({ available: true, run: overcite });
    await expect(decide(input)).rejects.toThrow(/un-grounded|out of range/i);
  });

  it('THROWS when copilot is unavailable (no deterministic fabrication — the stage falls back)', async () => {
    const decide = makeComposeDecider({ available: false, run: async () => '{}' });
    await expect(decide(input)).rejects.toThrow(/unavailable/i);
  });

  // COPILOT-CONTEXT-SCOPE-BUG regression (fail-before/pass-after): the real defaultRunner must pass
  // the threaded vaultPath to execFile as `cwd` so Copilot scans the staging worktree, not `/`.
  it('runs the real Copilot subprocess in the threaded vaultPath (execFile cwd)', async () => {
    vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '{}', stderr: '' });
      return {} as never;
    }) as never);
    await makeComposeDecider({ available: true, vaultPath: '/vault/.kb/cache/worktrees/staging' })(input).catch(() => {});
    const opts = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe('/vault/.kb/cache/worktrees/staging');
  });

  it('leaves execFile cwd undefined when no vaultPath is set (unscoped)', async () => {
    vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '{}', stderr: '' });
      return {} as never;
    }) as never);
    await makeComposeDecider({ available: true })(input).catch(() => {});
    const opts = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBeUndefined();
  });
});
