// Claims decision validation (SPEC-0016 CLAIMS-6/8/10/12). Pure parser — no FS/git.
import { describe, it, expect } from 'vitest';
import { parseClaimsDecision, CLAIM_STATUSES } from './claims';

const valid = JSON.stringify({
  entityId: '01JENT',
  claims: [
    { statement: 'Owns the Q3 budget.', status: 'interpretation', confidence: 0.7, mentions: ['Steve owns the Q3 budget'], relatesTo: ['Austin site'] },
  ],
});

describe('parseClaimsDecision (CLAIMS-6)', () => {
  it('parses a well-formed decision with full epistemics + provenance evidence', () => {
    const d = parseClaimsDecision(valid, '01JENT');
    expect(d.entityId).toBe('01JENT');
    expect(d.claims).toHaveLength(1);
    expect(d.claims[0]).toMatchObject({
      statement: 'Owns the Q3 budget.',
      status: 'interpretation',
      confidence: 0.7,
      mentions: ['Steve owns the Q3 budget'],
      relatesTo: ['Austin site'],
    });
  });

  it('tolerates surrounding prose/markdown by extracting the first JSON object', () => {
    const d = parseClaimsDecision('Sure! Here:\n```json\n' + valid + '\n```', '01JENT');
    expect(d.claims[0].statement).toBe('Owns the Q3 budget.');
  });

  it('an empty claims[] is a valid outcome (CLAIMS §3.6)', () => {
    const d = parseClaimsDecision('{"entityId":"01JENT","claims":[]}', '01JENT');
    expect(d.claims).toEqual([]);
  });
});

describe('status is a CLOSED set (CLAIMS-8)', () => {
  it('accepts each of fact|interpretation|hypothesis', () => {
    for (const status of CLAIM_STATUSES) {
      const d = parseClaimsDecision(JSON.stringify({ entityId: 'e', claims: [{ statement: 's', status, confidence: 0.5, mentions: ['m'] }] }));
      expect(d.claims[0].status).toBe(status);
    }
  });

  it('REJECTS an unknown status (allow-list, unlike open kind/type)', () => {
    const bad = JSON.stringify({ entityId: 'e', claims: [{ statement: 's', status: 'rumor', confidence: 0.5, mentions: ['m'] }] });
    expect(() => parseClaimsDecision(bad)).toThrow(/status must be one of/);
  });
});

describe('relatesTo is an optional soft hint (CLAIMS-10)', () => {
  it('is omitted when absent', () => {
    const d = parseClaimsDecision('{"entityId":"e","claims":[{"statement":"s","status":"fact","confidence":1,"mentions":["m"]}]}');
    expect(d.claims[0].relatesTo).toBeUndefined();
  });

  it('drops an empty relatesTo[] to undefined (no noise)', () => {
    const d = parseClaimsDecision('{"entityId":"e","claims":[{"statement":"s","status":"fact","confidence":1,"mentions":["m"],"relatesTo":[]}]}');
    expect(d.claims[0].relatesTo).toBeUndefined();
  });
});

describe('validation guards never let a bad session pollute the graph (CLAIMS-12)', () => {
  it('throws on entityId mismatch (stale/confused session)', () => {
    expect(() => parseClaimsDecision(valid, 'DIFFERENT')).toThrow(/entityId mismatch/);
  });
  it('throws on a missing entityId', () => {
    expect(() => parseClaimsDecision('{"claims":[]}')).toThrow(/missing entityId/);
  });
  it('throws when claims is not an array', () => {
    expect(() => parseClaimsDecision('{"entityId":"e","claims":{}}')).toThrow(/claims must be an array/);
  });
  it('throws on a missing statement', () => {
    expect(() => parseClaimsDecision('{"entityId":"e","claims":[{"status":"fact","confidence":1,"mentions":["m"]}]}')).toThrow(/statement/);
  });
  it('throws on out-of-range confidence', () => {
    expect(() => parseClaimsDecision('{"entityId":"e","claims":[{"statement":"s","status":"fact","confidence":2,"mentions":["m"]}]}')).toThrow(/confidence/);
  });
  it('throws on non-string mentions', () => {
    expect(() => parseClaimsDecision('{"entityId":"e","claims":[{"statement":"s","status":"fact","confidence":1,"mentions":[3]}]}')).toThrow(/mentions/);
  });
  it('throws when there is no JSON object at all', () => {
    expect(() => parseClaimsDecision('absolutely not json')).toThrow(/no JSON object/);
  });
});

describe('signals reuse the decompose validator (CLAIMS-13)', () => {
  it('validates and carries optional signals', () => {
    const d = parseClaimsDecision('{"entityId":"e","claims":[],"signals":[{"type":"needs-research","note":"confirm externally"}]}');
    expect(d.signals).toEqual([{ type: 'needs-research', note: 'confirm externally' }]);
  });
  it('omits a signals key entirely when none are present', () => {
    const d = parseClaimsDecision('{"entityId":"e","claims":[]}');
    expect(d.signals).toBeUndefined();
  });
});

describe('reviews channel (SPEC-0018 REVIEW-14)', () => {
  it('parses reviews[] alongside claims', () => {
    const d = parseClaimsDecision('{"entityId":"e","claims":[],"reviews":[{"question":"is this Steve Jones?","detail":"ctx","refs":["Steve"]}]}');
    expect(d.reviews).toEqual([{ question: 'is this Steve Jones?', detail: 'ctx', refs: ['Steve'] }]);
  });
  it('omits reviews when absent', () => {
    expect(parseClaimsDecision('{"entityId":"e","claims":[]}').reviews).toBeUndefined();
  });
  it('throws on a review missing its detail/context (REVIEW-3)', () => {
    expect(() => parseClaimsDecision('{"entityId":"e","claims":[],"reviews":[{"question":"q"}]}')).toThrow(/detail/);
  });
});
