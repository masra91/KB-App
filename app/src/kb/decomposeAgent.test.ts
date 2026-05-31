import { describe, it, expect } from 'vitest';
import { buildDecomposePrompt, makeDecomposeDecider, type SourceInput } from './decomposeAgent';

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

  it('THROWS on bad output rather than inventing a decision (DECOMP-6)', async () => {
    await expect(makeDecomposeDecider({ available: true, run: async () => 'not json' })(input())).rejects.toThrow();
  });
});
