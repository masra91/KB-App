import { describe, it, expect } from 'vitest';
import { validateGrounding, parseComposeDecision, firstJsonObject, stripLeadingHashes, type ComposeDecision } from './compose';

const grounded: ComposeDecision = {
  entityId: '01JENT',
  sections: [
    { sentences: [{ text: 'Steve Jobs co-founded [[Apple]] in 1976.', claims: [1] }] },
    {
      heading: 'Leadership',
      sentences: [
        { text: 'He served as CEO.', claims: [2] },
        { text: 'He championed the original Macintosh.', claims: [2, 3] },
      ],
    },
  ],
};

describe('validateGrounding (COMPOSE-3 — every sentence traces to a claim)', () => {
  it('accepts a fully-cited decision', () => {
    expect(validateGrounding(grounded, 3)).toEqual([]);
  });

  it('flags an un-cited sentence as a defect (the core grounding rule)', () => {
    const bad: ComposeDecision = {
      entityId: '01JENT',
      sections: [{ sentences: [{ text: 'He was influential.', claims: [] }] }],
    };
    const errors = validateGrounding(bad, 3);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/un-?cited|un-?grounded/i);
  });

  it('flags a citation that points past the available claims', () => {
    const bad: ComposeDecision = {
      entityId: '01JENT',
      sections: [{ sentences: [{ text: 'A claim.', claims: [9] }] }],
    };
    expect(validateGrounding(bad, 3).join(' ')).toMatch(/out of range/i);
  });

  it('flags an empty body (no sections) — a node with claims must yield prose', () => {
    expect(validateGrounding({ entityId: 'x', sections: [] }, 3).join(' ')).toMatch(/no sections/i);
  });

  it('flags empty sentence text', () => {
    const bad: ComposeDecision = { entityId: 'x', sections: [{ sentences: [{ text: '   ', claims: [1] }] }] };
    expect(validateGrounding(bad, 3).join(' ')).toMatch(/empty sentence/i);
  });
});

describe('firstJsonObject — balanced extraction from wrapped output', () => {
  it('pulls a clean object out of surrounding prose / fences', () => {
    const wrapped = 'Here is the result:\n```json\n{"sections": []}\n```\nDone.';
    expect(firstJsonObject(wrapped)).toBe('{"sections": []}');
  });
  it('handles braces inside strings', () => {
    expect(firstJsonObject('{"text": "a } b { c"}')).toBe('{"text": "a } b { c"}');
  });
  it('returns null when there is no object', () => {
    expect(firstJsonObject('no json here')).toBeNull();
  });
});

describe('parseComposeDecision (ORCH-21 parse seam — grounding enforced at parse time)', () => {
  it('parses a grounded decision and stamps the entityId', () => {
    const json = JSON.stringify({ sections: grounded.sections });
    const d = parseComposeDecision(json, '01JENT', 3);
    expect(d.entityId).toBe('01JENT');
    expect(d.sections).toHaveLength(2);
    expect(d.sections[1].heading).toBe('Leadership');
  });

  it('extracts the object from copilot prose wrapping', () => {
    const wrapped = `Sure!\n\n{"sections":[{"sentences":[{"text":"A.","claims":[1]}]}]}\n\nLet me know.`;
    expect(() => parseComposeDecision(wrapped, 'e', 1)).not.toThrow();
  });

  it('REJECTS un-grounded output (an un-cited sentence) — like a failed attempt (COMPOSE-3)', () => {
    const json = JSON.stringify({ sections: [{ sentences: [{ text: 'Ungrounded.', claims: [] }] }] });
    expect(() => parseComposeDecision(json, 'e', 2)).toThrow(/un-grounded/i);
  });

  it('REJECTS a citation to a non-existent claim', () => {
    const json = JSON.stringify({ sections: [{ sentences: [{ text: 'Cite.', claims: [5] }] }] });
    expect(() => parseComposeDecision(json, 'e', 2)).toThrow(/un-grounded|out of range/i);
  });

  it('throws on malformed JSON / missing sections', () => {
    expect(() => parseComposeDecision('not json', 'e', 1)).toThrow(/no JSON object/i);
    expect(() => parseComposeDecision('{"foo": 1}', 'e', 1)).toThrow(/sections/i);
  });

  it('coerces stringy claim numbers from a sloppy agent', () => {
    const json = JSON.stringify({ sections: [{ sentences: [{ text: 'A.', claims: ['1'] }] }] });
    const d = parseComposeDecision(json, 'e', 1);
    expect(d.sections[0].sentences[0].claims).toEqual([1]);
  });

  it('strips leading `#`s the model leaves on a heading (compose prepends its own `## `) — KB-Lead `## ##` bug', () => {
    const json = JSON.stringify({
      sections: [
        { sentences: [{ text: 'Lede.', claims: [1] }] },
        { heading: '## Family', sentences: [{ text: 'Detail.', claims: [1] }] },
        { heading: '## ## Career', sentences: [{ text: 'More.', claims: [1] }] },
      ],
    });
    const d = parseComposeDecision(json, 'e', 1);
    expect(d.sections[1].heading).toBe('Family');
    expect(d.sections[2].heading).toBe('Career');
  });
});

describe('stripLeadingHashes (defensive heading normalization)', () => {
  it('removes a single, doubled, or absent `#` prefix and trims', () => {
    expect(stripLeadingHashes('## Family')).toBe('Family');
    expect(stripLeadingHashes('## ## Career')).toBe('Career');
    expect(stripLeadingHashes('#Family')).toBe('Family');
    expect(stripLeadingHashes('Family')).toBe('Family');
    expect(stripLeadingHashes('  ##  Spaced  ')).toBe('Spaced');
  });
});
