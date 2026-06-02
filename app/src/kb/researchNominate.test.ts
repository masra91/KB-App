// Self-nomination (SPEC-0028 RESEARCH-4 / D3 / ORCH-22). Pure heuristic + CLI-refines-with-fallback.
import { describe, it, expect } from 'vitest';
import { heuristicNominate, nominatePrompt, parseYesNo, makeCliSelfNominate } from './researchNominate';
import type { ResearcherConfig, ResearchRequest } from './researchers';

const web = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({
  id: 'web-1', template: 'web', prompt: 'find prior art on launches', egressTier: 'public-web', scope: 'global',
  budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true, ...over,
});
const req = (what = 'Project Atlas', context = 'launch'): ResearchRequest => ({ id: 'r1', ts: 't', by: { stage: 'decompose' }, what, why: 'unknown', context, dedupKey: 'k' });

describe('heuristicNominate (deterministic fallback)', () => {
  it('a researcher with no topics nominates (already eligible)', () => {
    expect(heuristicNominate(web({ topics: [] }), req())).toBe(true);
    expect(heuristicNominate(web(), req())).toBe(true);
  });
  it('a topic researcher nominates only on overlap', () => {
    expect(heuristicNominate(web({ topics: ['atlas'] }), req('Project Atlas'))).toBe(true);
    expect(heuristicNominate(web({ topics: ['zephyr'] }), req('Project Atlas', 'unrelated'))).toBe(false);
  });
});

describe('parseYesNo', () => {
  it('parses clear yes/no, null on ambiguous', () => {
    expect(parseYesNo('YES')).toBe(true);
    expect(parseYesNo('no, not relevant')).toBe(false);
    expect(parseYesNo('maybe')).toBeNull();
    expect(parseYesNo('yes and no')).toBeNull();
  });
});

describe('nominatePrompt — request-only framing (egress floor)', () => {
  it('includes the request + researcher framing, not KB content', () => {
    const p = nominatePrompt(web({ topics: ['atlas'] }), req());
    expect(p).toContain('find prior art on launches');
    expect(p).toContain('Project Atlas');
    expect(p).toMatch(/YES or NO/);
  });
});

describe('makeCliSelfNominate', () => {
  it('with no runner → deterministic heuristic', async () => {
    const nom = makeCliSelfNominate();
    expect(await nom(web({ topics: ['atlas'] }), req('Project Atlas'))).toBe(true);
    expect(await nom(web({ topics: ['zephyr'] }), req('Project Atlas', 'x'))).toBe(false);
  });
  it('with a runner → uses the parsed reply', async () => {
    expect(await makeCliSelfNominate(async () => 'NO')(web(), req())).toBe(false);
    expect(await makeCliSelfNominate(async () => 'Yes, definitely')(web({ topics: ['zephyr'] }), req('Atlas', 'x'))).toBe(true); // CLI overrides heuristic-no
  });
  it('falls back to the heuristic on an unparseable reply or a thrown call', async () => {
    expect(await makeCliSelfNominate(async () => 'hmm')(web({ topics: ['atlas'] }), req('Atlas'))).toBe(true); // ambiguous → heuristic(yes)
    expect(
      await makeCliSelfNominate(async () => {
        throw new Error('cli down');
      })(web({ topics: ['zephyr'] }), req('Atlas', 'x')),
    ).toBe(false); // error → heuristic(no)
  });
});
