// Claims agent: prompt composition + the disposable decider (SPEC-0016 CLAIMS-3/4/5/12).
import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { buildClaimsPrompt, makeClaimsDecider, type EntityInput } from './claimsAgent';
import { ODSP_SOURCE_ID, ODSP_SOURCE_TEXT, MASON_ENTITY, NGAN_ENTITY, MASON_CAREER_CLAIMS } from './claimsSubjectAttribution.fixture';

// COPILOT-CONTEXT-SCOPE-BUG: partial-mock node:child_process to drive the REAL defaultRunner and
// assert it forwards the threaded vaultPath to execFile as `cwd` (the actual consumption site).
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

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

  // SUBJECT-ATTRIBUTION (KB-Lead 04:55 #2): the prompt must anchor each claim to its ACTUAL subject and
  // forbid attaching a narrator's first-person claims to a co-mentioned person (the Ngan-inherits-Mason bug).
  it('anchors claims to the actual subject + forbids first-person/co-mention misattribution (SUBJECT-ATTRIBUTION)', () => {
    const p = buildClaimsPrompt(input());
    expect(p).toMatch(/SUBJECT ATTRIBUTION/);
    expect(p).toMatch(/grammatical SUBJECT/i);
    expect(p).toMatch(/co-mentioned/i); // names the failure mode
    expect(p).toMatch(/first-person/i); // first-person = the narrator, not a co-mention
    expect(p).toMatch(/EMPTY claims/i); // co-mentioned-only → empty
    expect(p).toMatch(/silently corrupts their page/i); // why it matters — bias toward omit-when-unsure
    // rule 4 (omit-when-unsure) — asserted distinctly so the instruction can't silently vanish (QD-2 bar):
    expect(p).toMatch(/cannot tell/i);
    expect(p).toMatch(/omit it/i);
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

  // COPILOT-CONTEXT-SCOPE-BUG regression (fail-before/pass-after): the real defaultRunner must pass
  // the threaded vaultPath to execFile as `cwd` so Copilot scans the staging worktree, not `/`.
  it('runs the real Copilot subprocess in the threaded vaultPath (execFile cwd)', async () => {
    vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '{}', stderr: '' });
      return {} as never;
    }) as never);
    await makeClaimsDecider({ available: true, vaultPath: '/vault/.kb/cache/worktrees/staging' })(input()).catch(() => {});
    const opts = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe('/vault/.kb/cache/worktrees/staging');
  });

  it('leaves execFile cwd undefined when no vaultPath is set (unscoped)', async () => {
    vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '{}', stderr: '' });
      return {} as never;
    }) as never);
    await makeClaimsDecider({ available: true })(input()).catch(() => {});
    const opts = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBeUndefined();
  });

  it('THROWS on bad output rather than inventing a decision (CLAIMS-12)', async () => {
    await expect(makeClaimsDecider({ available: true, run: async () => 'not json' })(input())).rejects.toThrow();
  });

  it('THROWS on a wrong-entity decision (CLAIMS-12 entityId guard)', async () => {
    const decide = makeClaimsDecider({ available: true, run: async () => '{"entityId":"OTHER","claims":[]}' });
    await expect(decide(input())).rejects.toThrow(/entityId mismatch/);
  });

  // SUBJECT-ATTRIBUTION class regression, through the REAL decider path (feedback-test-real-agent-path):
  // a PROMPT-FAITHFUL runner that models the live bug — a model attributing the narrator's first-person
  // career to a CO-MENTIONED colleague (Ngan inheriting Mason's career) — and only refrains when the
  // prompt explicitly forbids it. So the test hinges on the PROMPT: fails-before (no instruction → the
  // bug branch attributes Mason's career to Ngan) / passes-after (instruction present → Ngan gets none).
  const subjectAttributionRunner = async (prompt: string): Promise<string> => {
    // Whether the hardened prompt forbids attaching a narrator's first-person claims to a co-mention.
    const forbidsCoMention = /co-mentioned/i.test(prompt) && /first-person/i.test(prompt);
    const careerClaims = MASON_CAREER_CLAIMS.map((c) => ({ ...c, mentions: [...c.mentions] }));
    if (/entity\.name: Ngan/.test(prompt)) {
      // entity=Ngan: a naive model parrots the first-person career onto the co-mentioned colleague (the
      // bug). A model that follows the hardened prompt attributes nothing — she is only co-mentioned.
      return JSON.stringify({ entityId: NGAN_ENTITY.entityId, claims: forbidsCoMention ? [] : careerClaims });
    }
    // entity=Mason: he IS the first-person narrator → his career attaches to him either way (the control).
    return JSON.stringify({ entityId: MASON_ENTITY.entityId, claims: careerClaims });
  };
  const odspInput = (entity: { entityId: string; kind: string; name: string }): EntityInput => ({
    ...entity,
    source: { sourceId: ODSP_SOURCE_ID, kind: 'text', text: ODSP_SOURCE_TEXT },
  });

  it('does NOT attach the narrator’s first-person career to a co-mentioned colleague (SUBJECT-ATTRIBUTION)', async () => {
    const dNgan = await makeClaimsDecider({ available: true, run: subjectAttributionRunner })(odspInput(NGAN_ENTITY));
    // The fix: Mason's career must not leak onto Ngan — she's co-mentioned, not the subject.
    expect(dNgan.claims).toEqual([]);
    expect(dNgan.claims.some((c) => /Senior PM|Microsoft|migration/.test(c.statement))).toBe(false);
  });

  it('still attributes the narrator’s career to the ACTUAL subject — the fix doesn’t nuke real claims', async () => {
    const dMason = await makeClaimsDecider({ available: true, run: subjectAttributionRunner })(odspInput(MASON_ENTITY));
    expect(dMason.claims.length).toBeGreaterThan(0);
    expect(dMason.claims.some((c) => /Senior PM/.test(c.statement))).toBe(true);
  });

  // SUBJECT-ATTRIBUTION rule 4 (omit-when-unsure), a DISTINCT real-decider case gated on the omit/unsure
  // instruction SPECIFICALLY (`cannot tell` + `omit it`) — independent of the co-mention/first-person
  // rule above. A statement genuinely ambiguous about WHICH co-founder it's about: a guessing model
  // attaches it to THIS entity; a model told to omit-when-unsure leaves it out. Fails-before/passes-after.
  it('OMITS an ambiguously-attributed claim instead of guessing which subject it belongs to (SUBJECT-ATTRIBUTION rule 4)', async () => {
    const AMBIG_SOURCE = [
      'Founding Notes',
      '',
      'Jordan and Alex co-founded Helix in 2018 and ran it together out of a garage.',
      'That year one of them was promoted to CTO — the notes do not say which.',
    ].join('\n');
    const JORDAN = { entityId: '01JJORDAN0000000000000000', kind: 'person', name: 'Jordan' };
    const ambiguousRunner = async (prompt: string): Promise<string> => {
      const forbidsGuessing = /cannot tell/i.test(prompt) && /omit it/i.test(prompt);
      const cofound = { statement: 'Co-founded Helix in 2018', status: 'fact', confidence: 0.9, mentions: ['Jordan and Alex co-founded Helix in 2018'] };
      // The CTO promotion is ambiguous between the two co-founders — a guessing model pins it on Jordan.
      const ambiguousCto = { statement: 'Promoted to CTO in 2018', status: 'fact', confidence: 0.5, mentions: ['one of them was promoted to CTO'] };
      return JSON.stringify({ entityId: JORDAN.entityId, claims: forbidsGuessing ? [cofound] : [cofound, ambiguousCto] });
    };
    const d = await makeClaimsDecider({ available: true, run: ambiguousRunner })({
      ...JORDAN,
      source: { sourceId: '01JAMBIGSRC0000000000000', kind: 'text', text: AMBIG_SOURCE },
    });
    // The ambiguous "promoted to CTO" is omitted (not guessed onto Jordan); the unambiguous co-founding stays.
    expect(d.claims.some((c) => /CTO/.test(c.statement))).toBe(false);
    expect(d.claims.some((c) => /Co-founded/.test(c.statement))).toBe(true);
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
