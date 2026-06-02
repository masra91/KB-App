import { describe, it, expect } from 'vitest';
import { parseDecomposeDecision } from './decompose';

const ok = JSON.stringify({
  sourceId: '01JSRC',
  entities: [{ kind: 'person', name: 'Steve', confidence: 0.9, mentions: ['call Steve'] }],
});

describe('parseDecomposeDecision (DECOMP-6)', () => {
  it('parses a clean decision', () => {
    const d = parseDecomposeDecision(ok);
    expect(d.sourceId).toBe('01JSRC');
    expect(d.entities).toHaveLength(1);
    expect(d.entities[0].name).toBe('Steve');
  });

  it('tolerates surrounding prose / markdown fences', () => {
    const out = 'Sure:\n```json\n' + ok + '\n```\nDone.';
    expect(parseDecomposeDecision(out).entities[0].kind).toBe('person');
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseDecomposeDecision('no json here')).toThrow();
  });

  it('throws on sourceId mismatch (stale session guard)', () => {
    expect(() => parseDecomposeDecision(ok, '01OTHER')).toThrow(/mismatch/);
  });

  it('accepts an empty entity list (valid empty result; DECOMP edge)', () => {
    const d = parseDecomposeDecision(JSON.stringify({ sourceId: '01JSRC', entities: [] }));
    expect(d.entities).toHaveLength(0);
  });
});

describe('open vocabularies — kind & signal type are NOT allow-listed (DECOMP-7, DECOMP-10)', () => {
  it('accepts an emergent, never-seen entity kind', () => {
    const d = parseDecomposeDecision(
      JSON.stringify({ sourceId: 's', entities: [{ kind: 'regulatory-filing', name: 'X', confidence: 0.5, mentions: ['x'] }] }),
    );
    expect(d.entities[0].kind).toBe('regulatory-filing');
  });

  it('accepts an emergent, never-seen signal type', () => {
    const d = parseDecomposeDecision(
      JSON.stringify({
        sourceId: 's',
        entities: [],
        signals: [{ type: 'totally-made-up-signal', note: 'fyi' }],
      }),
    );
    expect(d.signals?.[0].type).toBe('totally-made-up-signal');
  });

  it('rejects an EMPTY kind (only non-empty-string is enforced)', () => {
    expect(() =>
      parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [{ kind: '', name: 'X', confidence: 0.5, mentions: ['x'] }] })),
    ).toThrow(/kind/);
  });

  it('rejects an EMPTY signal type', () => {
    expect(() =>
      parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [], signals: [{ type: '   ', note: 'n' }] })),
    ).toThrow(/type/);
  });

  it('carries research-request fields (what/context) through verbatim (SPEC-0028 RESEARCH-3)', () => {
    const d = parseDecomposeDecision(
      JSON.stringify({
        sourceId: 's',
        entities: [],
        signals: [{ type: 'research-request', what: 'Project Atlas', note: 'unexplained term', context: 'we shipped on Atlas' }],
      }),
    );
    expect(d.signals?.[0]).toMatchObject({ type: 'research-request', what: 'Project Atlas', note: 'unexplained term', context: 'we shipped on Atlas' });
  });

  it('rejects an EMPTY research-request `what` (non-empty string when present)', () => {
    expect(() =>
      parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [], signals: [{ type: 'research-request', what: '  ', note: 'n' }] })),
    ).toThrow(/what/);
  });
});

describe('field validation (DECOMP-6)', () => {
  it('rejects confidence out of [0,1]', () => {
    expect(() =>
      parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [{ kind: 'person', name: 'A', confidence: 1.5, mentions: ['a'] }] })),
    ).toThrow(/confidence/);
  });

  it('rejects a missing name', () => {
    expect(() =>
      parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [{ kind: 'person', confidence: 0.5, mentions: ['a'] }] })),
    ).toThrow(/name/);
  });

  it('rejects non-string mentions', () => {
    expect(() =>
      parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [{ kind: 'person', name: 'A', confidence: 0.5, mentions: [42] }] })),
    ).toThrow(/mentions/);
  });

  it('drops an empty signals array (kept undefined)', () => {
    const d = parseDecomposeDecision(JSON.stringify({ sourceId: 's', entities: [], signals: [] }));
    expect(d.signals).toBeUndefined();
  });
});
