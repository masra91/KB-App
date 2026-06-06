// Claims agent: prompt composition + the disposable decider (SPEC-0016 CLAIMS-3/4/5/12).
import { describe, it, expect } from 'vitest';
import { buildClaimsPrompt, makeClaimsDecider, type EntityInput } from './claimsAgent';

const input = (over: Partial<EntityInput> = {}): EntityInput => ({
  entityId: '01JENT',
  kind: 'person',
  name: 'Steve',
  source: { sourceId: '01JSRC', kind: 'text', text: 'Steve owns the Q3 budget and visited the Austin site.' },
  ...over,
});

describe('buildClaimsPrompt (CLAIMS-3/5/8/10)', () => {
  it('feeds the WHOLE source text + the entity identity (CLAIMS-5)', () => {
    const p = buildClaimsPrompt(input());
    expect(p).toContain('entityId: 01JENT');
    expect(p).toContain('entity.name: Steve');
    expect(p).toContain('Steve owns the Q3 budget and visited the Austin site.');
    expect(p).toContain('ONLY a JSON object');
  });

  it('states the CLOSED status set in prose (CLAIMS-8)', () => {
    expect(buildClaimsPrompt(input())).toContain('fact, interpretation, hypothesis');
  });

  it('MANDATES relatesTo extraction of explicitly-named entities, still NOT a typed link (CLAIMS-10)', () => {
    const p = buildClaimsPrompt(input());
    expect(p).toMatch(/single-subject/i);
    expect(p).toMatch(/MUST list those names verbatim/); // mandatory extraction — feeds Connect link-promotion (CONNECT-12)
    expect(p).toMatch(/relatesTo/);
    expect(p).toMatch(/not a claim of any typed relationship/i); // extraction ≠ asserted relation (CLAIMS-10 stays intact)
    expect(p).toMatch(/do not assert relationships as fact/i);
  });
});

describe('makeClaimsDecider (CLAIMS-3/4/12)', () => {
  it('uses the injected runner and stamps an ORCH-16 agent trace', async () => {
    const decide = makeClaimsDecider({
      available: true,
      run: async () => '{"entityId":"01JENT","claims":[{"statement":"Owns the Q3 budget.","status":"interpretation","confidence":0.7,"mentions":["Steve owns the Q3 budget"]}]}',
    });
    const d = await decide(input());
    expect(d.claims[0].statement).toBe('Owns the Q3 budget.');
    expect(d.agent?.via).toBe('copilot');
    expect(d.agent?.ok).toBe(true);
  });

  it('THROWS when copilot is unavailable — never fabricates claims (CLAIMS-12)', async () => {
    await expect(makeClaimsDecider({ available: false })(input())).rejects.toThrow(/unavailable/);
  });

  it('THROWS on bad output rather than inventing a decision (CLAIMS-12)', async () => {
    await expect(makeClaimsDecider({ available: true, run: async () => 'not json' })(input())).rejects.toThrow();
  });

  it('THROWS on a wrong-entity decision (CLAIMS-12 entityId guard)', async () => {
    const decide = makeClaimsDecider({ available: true, run: async () => '{"entityId":"OTHER","claims":[]}' });
    await expect(decide(input())).rejects.toThrow(/entityId mismatch/);
  });
});

describe('review guidance in the prompt (SPEC-0018 REVIEW-14/6)', () => {
  it('tells the agent it may raise a yes/no review instead of guessing', () => {
    const p = buildClaimsPrompt(input());
    expect(p).toMatch(/raise a REVIEW/i);
    expect(p).toContain('reviews[]');
  });
  it('feeds already-answered reviews back as authoritative (REVIEW-6)', () => {
    const p = buildClaimsPrompt(input({ priorReviews: [{ question: 'Is this Steve Jones?', verdict: 'reject', note: "it's Steve Lin" }] }));
    expect(p).toContain('ALREADY answered');
    expect(p).toContain('Is this Steve Jones?');
    expect(p).toContain("it's Steve Lin");
  });
});
