import { describe, it, expect } from 'vitest';
import { renderProse, applyProse, stripProse, hasProse, resolveProseWikilinks } from './composeDoc';
import { LINKS_BLOCK_START, LINKS_BLOCK_END } from './connectDoc';
import { CLAIMS_BLOCK_START, CLAIMS_BLOCK_END } from './claimDoc';
import type { ComposeDecision, CitedClaim } from './compose';

const CLAIMS: CitedClaim[] = [
  { statement: 'Co-founded Apple in 1976.', sourceRel: 'sources/2026/05/30/01SA', title: 'Apple keynote notes (2026-05-30)' },
  { statement: 'Served as CEO.', sourceRel: 'sources/2026/05/31/01SB', title: 'Q3 board memo (2026-05-31)' },
  { statement: 'Championed the Macintosh.', sourceRel: 'sources/2026/05/30/01SA', title: 'Apple keynote notes (2026-05-30)' },
];

const DECISION: ComposeDecision = {
  entityId: '01JENT',
  sections: [
    { sentences: [{ text: 'Steve Jobs co-founded [[Apple]] in 1976.', claims: [1] }] },
    {
      heading: 'Leadership',
      sentences: [
        { text: 'He served as CEO.', claims: [2] },
        { text: 'He championed the original Macintosh.', claims: [3] },
      ],
    },
  ],
};

describe('renderProse (COMPOSE-1/2/4/8)', () => {
  it('renders a lede + a ## section with woven [[links]] and inline [^n] citations', () => {
    const prose = renderProse(DECISION, CLAIMS);
    expect(prose).toContain('Steve Jobs co-founded [[Apple]] in 1976.[^1]'); // lede, cite after the period
    expect(prose).toContain('## Leadership');
    expect(prose).toContain('He served as CEO.[^2]');
  });

  it('uses SOURCE-level footnotes — two claims sharing a source share one [^n], References lists it once', () => {
    const prose = renderProse(DECISION, CLAIMS);
    // claim 1 and claim 3 share source 01SA → both render [^1]; claim 2 (01SB) → [^2].
    expect(prose).toContain('He championed the original Macintosh.[^1]');
    expect(prose).toContain('He served as CEO.[^2]');
    // References lists each cited SOURCE once, by human title, navigable (COMPOSE-2/8, never a ULID).
    expect(prose).toContain('## References');
    expect(prose).toContain('[^1]: [[sources/2026/05/30/01SA/source.md|Apple keynote notes (2026-05-30)]]');
    expect(prose).toContain('[^2]: [[sources/2026/05/31/01SB/source.md|Q3 board memo (2026-05-31)]]');
    // 01SA appears once in References, not twice.
    expect(prose.match(/\[\^1\]: /g)).toHaveLength(1);
  });

  it('numbers footnotes in reading order (first cited source is [^1])', () => {
    const d: ComposeDecision = {
      entityId: 'e',
      sections: [{ sentences: [{ text: 'CEO first.', claims: [2] }, { text: 'Then founding.', claims: [1] }] }],
    };
    const prose = renderProse(d, CLAIMS);
    expect(prose).toContain('CEO first.[^1]'); // claim 2's source cited first → [^1]
    expect(prose).toContain('Then founding.[^2]');
  });

  it('merges a multi-claim sentence into deduped, sorted markers', () => {
    const d: ComposeDecision = { entityId: 'e', sections: [{ sentences: [{ text: 'Both.', claims: [2, 1, 3] }] }] };
    // sources: claim2→01SB, claim1→01SA, claim3→01SA. First appearance order: 01SB→[^1], 01SA→[^2].
    const prose = renderProse(d, CLAIMS);
    expect(prose).toContain('Both.[^1][^2]');
  });

  it('renders a heading once even when the model leaves leading `#`s on it (no `## ## Family` — KB-Lead bug)', () => {
    const d: ComposeDecision = {
      entityId: 'e',
      sections: [
        { sentences: [{ text: 'Lede.', claims: [1] }] },
        { heading: '## Family', sentences: [{ text: 'He served as CEO.', claims: [2] }] }, // model already prepended ##
        { heading: '## ## Career', sentences: [{ text: 'Championed it.', claims: [3] }] }, // doubled prefix
      ],
    };
    const prose = renderProse(d, CLAIMS);
    expect(prose).toContain('## Family');
    expect(prose).not.toContain('## ## Family');
    expect(prose).toContain('## Career');
    expect(prose).not.toContain('## ## Career');
  });

  it('recognizes + drops a hashed "## References" section (the strip lets the dedup check match)', () => {
    const d: ComposeDecision = {
      entityId: 'e',
      sections: [
        { sentences: [{ text: 'Real.', claims: [1] }] },
        { heading: '## References', sentences: [{ text: 'junk', claims: [1] }] },
      ],
    };
    const prose = renderProse(d, CLAIMS);
    expect(prose).not.toContain('junk');
    expect(prose.match(/## References/g)).toHaveLength(1);
  });

  it('drops a spurious agent-authored "References" section (Compose owns References)', () => {
    const d: ComposeDecision = {
      entityId: 'e',
      sections: [
        { sentences: [{ text: 'Real.', claims: [1] }] },
        { heading: 'References', sentences: [{ text: 'junk', claims: [1] }] },
      ],
    };
    const prose = renderProse(d, CLAIMS);
    expect(prose).not.toContain('junk');
    expect(prose.match(/## References/g)).toHaveLength(1); // only the generated one
  });
});

// A realistic post-Claims entity node: frontmatter + H1 + links block + claims block, no prose yet.
function entityNode(): string {
  return [
    '---',
    'id: 01JENT',
    'kind: person',
    'name: Steve Jobs',
    '---',
    '',
    '# Steve Jobs',
    '',
    `${LINKS_BLOCK_START}`,
    '- [[entities/organization/Apple.md|Apple]]',
    `${LINKS_BLOCK_END}`,
    `${CLAIMS_BLOCK_START}`,
    '- [[claims/2026/05/30/01C.md]] — Co-founded Apple. *(fact, 0.9)*',
    `${CLAIMS_BLOCK_END}`,
    '',
  ].join('\n');
}

describe('applyProse (COMPOSE-5 — keep structured blocks below; idempotent region surgery)', () => {
  it('inserts prose between the H1 and the structured blocks, preserving frontmatter, H1 and BOTH blocks', () => {
    const out = applyProse(entityNode(), renderProse(DECISION, CLAIMS));
    // identity + H1 intact
    expect(out).toContain('id: 01JENT');
    expect(out).toMatch(/# Steve Jobs/);
    // prose sits above the blocks
    const proseAt = out.indexOf('co-founded [[Apple]]');
    const linksAt = out.indexOf(LINKS_BLOCK_START);
    const claimsAt = out.indexOf(CLAIMS_BLOCK_START);
    expect(proseAt).toBeGreaterThan(out.indexOf('# Steve Jobs'));
    expect(proseAt).toBeLessThan(linksAt);
    // COMPOSE-5: both structured blocks kept, in order, below the prose
    expect(linksAt).toBeLessThan(claimsAt);
    expect(out).toContain('- [[entities/organization/Apple.md|Apple]]');
    expect(out).toContain('- [[claims/2026/05/30/01C.md]] — Co-founded Apple. *(fact, 0.9)*');
  });

  it('is idempotent — re-applying the same prose is byte-stable', () => {
    const once = applyProse(entityNode(), renderProse(DECISION, CLAIMS));
    const twice = applyProse(once, renderProse(DECISION, CLAIMS));
    expect(twice).toBe(once);
  });

  it('regenerates WHOLE — a second, different compose replaces the prior prose (no accretion)', () => {
    const first = applyProse(entityNode(), renderProse(DECISION, CLAIMS));
    const second = applyProse(first, renderProse({ entityId: 'e', sections: [{ sentences: [{ text: 'New lede.', claims: [1] }] }] }, CLAIMS));
    expect(second).toContain('New lede.[^1]');
    expect(second).not.toContain('co-founded [[Apple]]'); // old prose gone
    expect(second).toContain(CLAIMS_BLOCK_START); // blocks survive
  });

  it('empty body strips the prose back to blocks-only (the deterministic fallback)', () => {
    const composed = applyProse(entityNode(), renderProse(DECISION, CLAIMS));
    const stripped = stripProse(composed);
    expect(stripped).not.toContain('co-founded [[Apple]]');
    expect(stripped).not.toContain('## References');
    expect(stripped).toContain(LINKS_BLOCK_START);
    expect(stripped).toContain(CLAIMS_BLOCK_START);
  });

  it('keeps a claims-only node (no links block) intact', () => {
    const node = ['---', 'id: 01X', 'kind: person', 'name: A', '---', '', '# A', '', CLAIMS_BLOCK_START, '- x', CLAIMS_BLOCK_END, ''].join('\n');
    const out = applyProse(node, 'Some prose.[^1]');
    expect(out).toContain('Some prose.[^1]');
    expect(out.indexOf('Some prose')).toBeLessThan(out.indexOf(CLAIMS_BLOCK_START));
    expect(out).toContain(CLAIMS_BLOCK_END);
  });

  it('degrades on a malformed node (no H1) without crashing', () => {
    expect(() => applyProse('just some text', 'Prose.[^1]')).not.toThrow();
  });
});

describe('hasProse', () => {
  it('is false for a fresh post-Claims node and true after composing', () => {
    expect(hasProse(entityNode())).toBe(false);
    expect(hasProse(applyProse(entityNode(), renderProse(DECISION, CLAIMS)))).toBe(true);
  });
});

describe('resolveProseWikilinks (COHERE-1 — bare [[Name]] → entity path)', () => {
  // A composed node: H1 + prose region + the kb:links / kb:claims structured blocks below.
  const composed = (prose: string): string =>
    [
      '---', 'id: 01JENT', 'kind: person', 'name: Steve Jobs', '---', '',
      '# Steve Jobs', '',
      prose, '',
      LINKS_BLOCK_START, '- [[entities/organization/Apple.md|Apple]]', LINKS_BLOCK_END,
      CLAIMS_BLOCK_START, '- [[claims/2026/05/30/01C.md]] — also names [[Harrie]]', CLAIMS_BLOCK_END, '',
    ].join('\n');

  const resolve = (name: string): string | null =>
    ({ Harrie: 'entities/person/Harrie.md', 'Jordan Reyes': 'entities/person/Jordan Reyes.md' }[name] ?? null);

  it('rewrites a bare prose [[Name]] to [[rel|Name]] on a unique match', () => {
    const out = resolveProseWikilinks(composed('Jobs worked with [[Harrie]] and [[Jordan Reyes]] often.'), resolve);
    expect(out).toContain('[[entities/person/Harrie.md|Harrie]]');
    expect(out).toContain('[[entities/person/Jordan Reyes.md|Jordan Reyes]]');
  });

  it('leaves an UNKNOWN bare link bare (CONNECT-13 — never a dangling guess)', () => {
    const out = resolveProseWikilinks(composed('Met [[Ghost Person]] once.'), resolve);
    expect(out).toContain('[[Ghost Person]]');
    expect(out).not.toContain('Ghost Person.md');
  });

  it('leaves already-piped or path-form links untouched', () => {
    const out = resolveProseWikilinks(composed('See [[entities/org/Acme.md|Acme]] and [[some/path]].'), resolve);
    expect(out).toContain('[[entities/org/Acme.md|Acme]]');
    expect(out).toContain('[[some/path]]');
  });

  it('only touches the PROSE region — the kb:links / kb:claims blocks are byte-identical', () => {
    const node = composed('Worked with [[Harrie]].');
    const out = resolveProseWikilinks(node, resolve);
    // prose got resolved …
    expect(out).toContain('Worked with [[entities/person/Harrie.md|Harrie]].');
    // … but the bare [[Harrie]] INSIDE the claims block is left alone (blocks are not prose).
    const block = out.slice(out.indexOf(CLAIMS_BLOCK_START));
    expect(block).toContain('also names [[Harrie]]');
    expect(block).not.toContain('entities/person/Harrie.md|Harrie');
  });

  it('is idempotent — a resolved link (now piped) is not rewritten again', () => {
    const once = resolveProseWikilinks(composed('Worked with [[Harrie]].'), resolve);
    const twice = resolveProseWikilinks(once, resolve);
    expect(twice).toBe(once);
  });

  it('ENG-16: a throwing resolver leaves the link as-is, never corrupts the doc', () => {
    const out = resolveProseWikilinks(composed('Worked with [[Harrie]].'), () => {
      throw new Error('resolver blew up');
    });
    expect(out).toContain('[[Harrie]]'); // unchanged
  });

  it('ENG-16: a node with no prose region is returned unchanged (no crash)', () => {
    const noProse = ['---', 'id: 01X', 'kind: person', 'name: A', '---', '', '# A', '', LINKS_BLOCK_START, '- [[Harrie]]', LINKS_BLOCK_END, ''].join('\n');
    expect(resolveProseWikilinks(noProse, resolve)).toBe(noProse);
    expect(() => resolveProseWikilinks('just loose text [[Harrie]]', resolve)).not.toThrow();
  });
});
