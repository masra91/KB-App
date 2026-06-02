import { describe, it, expect } from 'vitest';
import { buildConnectPrompt, makeConnectDecider, type CandidateSet } from './connectAgent';
import type { Candidate } from './connect';

const cand = (id: string, name: string, source: string): Candidate => ({
  id,
  sourceId: source,
  kind: 'person',
  name,
  confidence: 0.8,
  mentions: [name],
});

const set = (over: Partial<CandidateSet> = {}): CandidateSet => ({
  blockKey: 'person|steve jobs',
  kind: 'person',
  candidates: [cand('01A', 'Steve Jobs', '01S1'), cand('01B', 'Steve Jobs', '01S2')],
  existingNodes: [],
  ...over,
});

describe('buildConnectPrompt (CONNECT-5)', () => {
  it('lists candidates with ids + sources and asks for one cluster per real thing', () => {
    const p = buildConnectPrompt(set());
    expect(p).toContain('id: 01A');
    expect(p).toContain('id: 01B');
    expect(p).toContain('blockKey: person|steve jobs');
    expect(p).toMatch(/one CLUSTER per distinct real thing/i);
    expect(p).toContain('ONLY a JSON object');
  });
  it('tells the agent to raise a review rather than guess on ambiguity', () => {
    expect(buildConnectPrompt(set())).toMatch(/raise a\s*\n?\s*review instead of guessing/i);
  });
  it('shows existing same-key nodes for fold-in, or (none)', () => {
    expect(buildConnectPrompt(set())).toContain('(none)');
    expect(buildConnectPrompt(set({ existingNodes: [{ id: 'N1', name: 'Steve Jobs' }] }))).toContain('existingNodeId: N1');
  });
});

describe('makeConnectDecider (CONNECT-5/14)', () => {
  it('uses the injected runner and stamps an ORCH-16 trace; validates the partition', async () => {
    const decide = makeConnectDecider({
      available: true,
      run: async () => '{"blockKey":"person|steve jobs","clusters":[{"canonicalName":"Steve Jobs","memberCandidateIds":["01A","01B"],"confidence":0.95}]}',
    });
    const d = await decide(set());
    expect(d.clusters[0].canonicalName).toBe('Steve Jobs');
    expect(d.agent?.via).toBe('copilot');
    expect(d.agent?.ok).toBe(true);
  });

  it('THROWS when copilot is unavailable — never fabricates a resolution (CONNECT-14)', async () => {
    await expect(makeConnectDecider({ available: false })(set())).rejects.toThrow(/unavailable/);
  });

  it('THROWS when the verdict does not partition the set (a dropped candidate)', async () => {
    const decide = makeConnectDecider({
      available: true,
      run: async () => '{"blockKey":"person|steve jobs","clusters":[{"canonicalName":"Steve Jobs","memberCandidateIds":["01A"],"confidence":0.9}]}',
    });
    await expect(decide(set())).rejects.toThrow(/covers 1 of 2/);
  });

  it('THROWS on unparseable output', async () => {
    await expect(makeConnectDecider({ available: true, run: async () => 'sorry' })(set())).rejects.toThrow();
  });
});
