import { describe, it, expect } from 'vitest';
import { parseConnectDecision, validCandidate, normalizeName, blockKey } from './connect';

const okVerdict = JSON.stringify({
  blockKey: 'person|steve jobs',
  clusters: [{ canonicalName: 'Steve Jobs', memberCandidateIds: ['01A', '01B'], confidence: 0.95 }],
});

describe('parseConnectDecision (CONNECT-14)', () => {
  it('parses a clean verdict', () => {
    const d = parseConnectDecision(okVerdict);
    expect(d.blockKey).toBe('person|steve jobs');
    expect(d.clusters).toHaveLength(1);
    expect(d.clusters[0].memberCandidateIds).toEqual(['01A', '01B']);
  });

  it('tolerates surrounding prose / fences', () => {
    expect(parseConnectDecision('Sure:\n```json\n' + okVerdict + '\n```').clusters[0].canonicalName).toBe('Steve Jobs');
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseConnectDecision('no json here')).toThrow();
  });

  it('throws on blockKey mismatch (stale-session guard)', () => {
    expect(() => parseConnectDecision(okVerdict, 'person|other')).toThrow(/blockKey mismatch/);
  });

  it('requires a non-empty clusters array', () => {
    expect(() => parseConnectDecision(JSON.stringify({ blockKey: 'k', clusters: [] }))).toThrow(/clusters/);
  });
});

describe('verdict must PARTITION the candidate set (CONNECT-14)', () => {
  const ids = ['01A', '01B', '01C'];

  it('accepts a verdict that covers every id exactly once across clusters', () => {
    const v = JSON.stringify({
      blockKey: 'k',
      clusters: [
        { canonicalName: 'A', memberCandidateIds: ['01A', '01B'], confidence: 0.9 },
        { canonicalName: 'C', memberCandidateIds: ['01C'], confidence: 0.9 },
      ],
    });
    expect(parseConnectDecision(v, 'k', ids).clusters).toHaveLength(2);
  });

  it('rejects an unknown candidate id', () => {
    const v = JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A', '99Z'], confidence: 0.9 }] });
    expect(() => parseConnectDecision(v, 'k', ids)).toThrow(/unknown candidate id/);
  });

  it('rejects a candidate appearing in two clusters', () => {
    const v = JSON.stringify({
      blockKey: 'k',
      clusters: [
        { canonicalName: 'A', memberCandidateIds: ['01A', '01B'], confidence: 0.9 },
        { canonicalName: 'B', memberCandidateIds: ['01B', '01C'], confidence: 0.9 },
      ],
    });
    expect(() => parseConnectDecision(v, 'k', ids)).toThrow(/more than one cluster/);
  });

  it('rejects a verdict that drops a candidate (incomplete partition)', () => {
    const v = JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], confidence: 0.9 }] });
    expect(() => parseConnectDecision(v, 'k', ids)).toThrow(/covers 1 of 3/);
  });
});

describe('optional channels (CONNECT-10, 15, 18)', () => {
  it('accepts mergeExistingNodeIds (CONNECT-10)', () => {
    const v = JSON.stringify({
      blockKey: 'k',
      clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], existingNodeId: 'N1', mergeExistingNodeIds: ['N2'], confidence: 0.9 }],
    });
    const d = parseConnectDecision(v);
    expect(d.clusters[0].existingNodeId).toBe('N1');
    expect(d.clusters[0].mergeExistingNodeIds).toEqual(['N2']);
  });

  it('coerces a blank existingNodeId to ABSENT instead of rejecting (#136 — agent "no existing node")', () => {
    for (const blank of ['', '   ']) {
      const d = parseConnectDecision(
        JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], existingNodeId: blank, confidence: 0.9 }] }),
      );
      expect(d.clusters[0].existingNodeId).toBeUndefined(); // born fresh, NOT a parse error → no wedge
    }
    // a present, non-blank id is trimmed + kept; a non-string is still genuinely malformed → throw
    const kept = parseConnectDecision(
      JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], existingNodeId: '  N1  ', confidence: 0.9 }] }),
    );
    expect(kept.clusters[0].existingNodeId).toBe('N1');
    expect(() =>
      parseConnectDecision(JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], existingNodeId: 123, confidence: 0.9 }] })),
    ).toThrow(/existingNodeId/);
  });

  it('drops blank entries from mergeExistingNodeIds (#136), but rejects a non-string element', () => {
    const d = parseConnectDecision(
      JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], mergeExistingNodeIds: ['N2', '', '  '], confidence: 0.9 }] }),
    );
    expect(d.clusters[0].mergeExistingNodeIds).toEqual(['N2']); // blanks dropped
    const allBlank = parseConnectDecision(
      JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], mergeExistingNodeIds: [''], confidence: 0.9 }] }),
    );
    expect(allBlank.clusters[0].mergeExistingNodeIds).toBeUndefined(); // all-blank → absent
    expect(() =>
      parseConnectDecision(JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], mergeExistingNodeIds: ['N2', 5], confidence: 0.9 }] })),
    ).toThrow(/mergeExistingNodeIds/);
  });

  it('carries reviews (CONNECT-15) and signals (CONNECT-18), drops empty arrays', () => {
    const v = JSON.stringify({
      blockKey: 'k',
      clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], confidence: 0.5 }],
      reviews: [{ question: 'Same person?', detail: 'ambiguous' }],
      signals: [{ type: 'note', note: 'kept apart' }],
    });
    const d = parseConnectDecision(v);
    expect(d.reviews).toHaveLength(1);
    expect(d.signals?.[0].type).toBe('note');

    const empty = parseConnectDecision(JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], confidence: 0.5 }], signals: [] }));
    expect(empty.signals).toBeUndefined();
  });

  it('rejects an out-of-range cluster confidence', () => {
    expect(() => parseConnectDecision(JSON.stringify({ blockKey: 'k', clusters: [{ canonicalName: 'A', memberCandidateIds: ['01A'], confidence: 2 }] }))).toThrow(/confidence/);
  });
});

describe('validCandidate (input contract)', () => {
  const base = { id: '01A', sourceId: '01S', kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] };
  it('accepts a well-formed candidate', () => {
    expect(validCandidate(base).name).toBe('Steve');
  });
  it('rejects a candidate missing mentions', () => {
    expect(() => validCandidate({ ...base, mentions: [] })).toThrow(/mentions/);
  });
  it('rejects a candidate with a bad confidence', () => {
    expect(() => validCandidate({ ...base, confidence: 'high' })).toThrow(/confidence/);
  });
});

describe('blocking normalization (CONNECT-4)', () => {
  it('normalizes case, whitespace, and punctuation', () => {
    expect(normalizeName('  Steve   JOBS! ')).toBe('steve jobs');
    expect(normalizeName('Steve-Jobs')).toBe('steve jobs');
  });
  it('blockKey groups same kind+normalized-name, separates different kinds', () => {
    expect(blockKey('person', 'Steve Jobs')).toBe(blockKey('Person', 'steve  jobs'));
    expect(blockKey('person', 'Steve')).not.toBe(blockKey('project', 'Steve'));
  });
});
