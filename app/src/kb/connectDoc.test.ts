import { describe, it, expect } from 'vitest';
import { renderEntityNode, parseEntityNode, slugify, entityFileRel, unionOrdered, renderLinksBlock, LINKS_BLOCK_START, LINKS_BLOCK_END, type EntityNode } from './connectDoc';

const node = (over: Partial<EntityNode> = {}): EntityNode => ({
  id: '01JENT',
  kind: 'person',
  name: 'Steve Jobs',
  confidence: 0.95,
  aliases: ['01JENT'],
  derivedFrom: ['sources/2026/05/30/01JA', 'sources/2026/05/31/01JB'],
  resolvedFrom: ['01CA', '01CB'],
  tags: ['type/person', 'topic/tech'],
  createdAt: '2026-05-31T00:00:00Z',
  updatedAt: '2026-05-31T00:00:00Z',
  agent: { via: 'copilot', model: 'test' },
  ...over,
});

describe('renderEntityNode (CONNECT-7/8, CANON-6)', () => {
  it('writes identity frontmatter + H1, with id/aliases and multi-source provenance', () => {
    const md = renderEntityNode(node());
    expect(md).toContain('id: 01JENT');
    expect(md).toContain('kind: person');
    expect(md).toMatch(/^name: "?Steve Jobs"?$/m); // unquoted (a space isn't YAML-significant)
    expect(md).toContain('aliases: ["01JENT"]');
    expect(md).toContain('derivedFrom: ["sources/2026/05/30/01JA", "sources/2026/05/31/01JB"]'); // CONNECT-8 multi-source
    expect(md).toContain('resolvedFrom: ["01CA", "01CB"]');
    expect(md).toContain('transformedBy: connect · copilot (test)');
    expect(md).toContain('# Steve Jobs');
  });

  it('emits the curated `type` Property + Obsidian `tags:` list (SPEC-0025 META-1/2/4)', () => {
    const md = renderEntityNode(node());
    expect(md).toContain('type: person'); // curated Property seeded from kind
    expect(md).toContain('tags: ["type/person", "topic/tech"]'); // native frontmatter tags list
    // region discipline (META-4): metadata is in the identity frontmatter, not a body block
    expect(md.indexOf('tags:')).toBeLessThan(md.indexOf('---', 4));
  });

  it('round-trips through parseEntityNode (fold/merge needs this — incl. tags)', () => {
    const parsed = parseEntityNode(renderEntityNode(node({ aliases: ['01JENT', 'Steven Jobs'], tags: ['type/person', 'topic/ml'] })));
    expect(parsed.id).toBe('01JENT');
    expect(parsed.name).toBe('Steve Jobs');
    expect(parsed.aliases).toEqual(['01JENT', 'Steven Jobs']);
    expect(parsed.derivedFrom).toHaveLength(2);
    expect(parsed.resolvedFrom).toEqual(['01CA', '01CB']);
    expect(parsed.tags).toEqual(['type/person', 'topic/ml']); // tags survive parse (fold preserves them)
  });

  it('parseEntityNode throws on a node missing identity (foreign/malformed → skipped by caller)', () => {
    expect(() => parseEntityNode('---\nfoo: bar\n---\n# x')).toThrow(/id\/kind\/name/);
  });
});

describe('human filenames (CONNECT-7, CANON-6/7)', () => {
  it('slugifies names', () => {
    expect(slugify('Steve Jobs')).toBe('steve-jobs');
    expect(slugify('Q3 Budget (2026)!')).toBe('q3-budget-2026');
    expect(slugify('   ')).toBe('unnamed');
  });
  it('produces entities/<kind>/<slug>.md', () => {
    expect(entityFileRel('person', 'Steve Jobs', '01JENT')).toBe('entities/person/steve-jobs.md');
  });
  it('disambiguates a within-kind collision with a short id suffix — never a ULID filename (CANON-7)', () => {
    const taken = new Set(['entities/person/steve-jobs.md']);
    const rel = entityFileRel('person', 'Steve Jobs', '01JABCDEF', taken);
    expect(rel).toBe('entities/person/steve-jobs-01jabc.md');
    expect(rel).not.toMatch(/01JABCDEF\.md$/);
  });
});

describe('unionOrdered (fold-in helper)', () => {
  it('preserves order and de-duplicates', () => {
    expect(unionOrdered(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('renderLinksBlock — entity-link display names (VAULT-12)', () => {
  it('renders the Obsidian alias form [[path|Name]] when the target name is known', () => {
    const block = renderLinksBlock([{ targetRel: 'entities/person/ada-lovelace.md', name: 'Ada Lovelace' }]);
    expect(block).toContain('- [[entities/person/ada-lovelace.md|Ada Lovelace]]');
    expect(block).toContain(LINKS_BLOCK_START);
    expect(block).toContain(LINKS_BLOCK_END);
  });
  it('falls back to a bare wikilink when no name is known (back-compat)', () => {
    expect(renderLinksBlock([{ targetRel: 'entities/person/x.md' }])).toContain('- [[entities/person/x.md]]');
  });
  it('keeps the predicate prefix in front of the alias link', () => {
    expect(renderLinksBlock([{ targetRel: 'entities/org/apple.md', name: 'Apple', predicate: 'works at' }])).toContain(
      '- works at [[entities/org/apple.md|Apple]]',
    );
  });
  it('placeholder when there are no resolved links (idempotent re-runs)', () => {
    expect(renderLinksBlock([])).toContain('_No resolved links yet._');
  });
});
