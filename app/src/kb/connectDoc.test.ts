import { describe, it, expect } from 'vitest';
import { renderEntityNode, parseEntityNode, slugify, entityFileName, entityFileRel, unionOrdered, renderLinksBlock, LINKS_BLOCK_START, LINKS_BLOCK_END, type EntityNode } from './connectDoc';

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

describe('SPEC-0025 META v1 — curated key-value Properties + Obsidian-native date migration', () => {
  it('writes `created`/`updated` as Obsidian-native curated date Properties (migrated from createdAt/updatedAt)', () => {
    const md = renderEntityNode(node({ createdAt: '2026-05-31T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' }));
    expect(md).toContain('created: 2026-05-31T00:00:00Z');
    expect(md).toContain('updated: 2026-06-01T00:00:00Z');
    expect(md).not.toMatch(/^createdAt:/m); // the legacy camelCase keys are gone (migrated to curated names)
    expect(md).not.toMatch(/^updatedAt:/m);
  });

  it('parses the legacy `createdAt:` for back-compat fold-in of a pre-migration node', () => {
    const legacy = '---\nid: 01J\nkind: person\nname: X\nderivedFrom: []\ncreatedAt: 2025-01-01T00:00:00Z\n---\n# X';
    expect(parseEntityNode(legacy).createdAt).toBe('2025-01-01T00:00:00Z');
    // the new `created` name is preferred when both are somehow present (mid-migration)
    const both = '---\nid: 01J\nkind: person\nname: X\ncreated: 2026-02-02T00:00:00Z\ncreatedAt: 2025-01-01T00:00:00Z\n---\n# X';
    expect(parseEntityNode(both).createdAt).toBe('2026-02-02T00:00:00Z');
  });

  it('renders dynamic curated Properties (scope/status/sensitivity) as flat Obsidian keys, in curated order', () => {
    // input order intentionally scrambled — output must be the fixed curated order (deterministic)
    const md = renderEntityNode(node({ properties: { sensitivity: 'internal', scope: 'work', status: 'active' } }));
    const iScope = md.indexOf('\nscope: work');
    const iStatus = md.indexOf('\nstatus: active');
    const iSens = md.indexOf('\nsensitivity: internal');
    expect(iScope).toBeGreaterThan(-1);
    expect(iScope).toBeLessThan(iStatus); // curated order: scope < status < sensitivity
    expect(iStatus).toBeLessThan(iSens);
    expect(iScope).toBeLessThan(md.indexOf('---', 4)); // identity region (META-4): inside the frontmatter
  });

  it('round-trips curated Properties and DROPS foreign/emergent keys (v1 = curated only)', () => {
    const parsed = parseEntityNode(renderEntityNode(node({ properties: { scope: 'work', mood: 'happy' } })));
    expect(parsed.properties).toEqual({ scope: 'work' }); // foreign `mood` is never rendered → never parsed
  });

  it('META S2: renders event dates as `<label>: <date>` + `<label>_precision:` markers, round-trips', () => {
    const dates = [
      { label: 'founded', date: '1976-01-01', precision: 'year' as const },
      { label: 'released', date: '2007-06-29', precision: 'day' as const },
    ];
    const md = renderEntityNode(node({ dates }));
    expect(md).toContain('founded: 1976-01-01');
    expect(md).toContain('founded_precision: year');
    expect(md).toContain('released: 2007-06-29');
    expect(md).toContain('released_precision: day');
    expect(md.indexOf('founded:')).toBeLessThan(md.indexOf('---', 4)); // identity region (META-4)
    expect(parseEntityNode(md).dates).toEqual(dates); // round-trips
  });

  it('META S2: an unpaired date (no `_precision` sibling) is NOT read back as an event date', () => {
    const raw = '---\nid: 01J\nkind: person\nname: X\nfounded: 1976-01-01\n---\n# X'; // no founded_precision
    expect(parseEntityNode(raw).dates).toEqual([]); // a bare date Property isn't an event date
  });

  it('parse-side gate: a foreign curated-looking key in raw frontmatter is dropped (QD-2 direct-parse)', () => {
    // A hand-edited / foreign node with a non-curated flat key — parse must keep only curated dynamic
    // Properties (scope/status/sensitivity), never an arbitrary key (defends the curated-only contract
    // at the READ boundary, not just render).
    const raw = '---\nid: 01J\nkind: person\nname: X\nscope: work\nmood: happy\nsensitivity: internal\n---\n# X';
    expect(parseEntityNode(raw).properties).toEqual({ scope: 'work', sensitivity: 'internal' }); // `mood` dropped
  });

  it('omits absent/blank curated Properties (no empty-key clutter)', () => {
    const md = renderEntityNode(node({ properties: { scope: '   ', status: 'active' } }));
    expect(md).not.toMatch(/^scope:/m); // a blank value is omitted
    expect(md).toContain('status: active');
    expect(renderEntityNode(node())).not.toMatch(/^scope:/m); // no properties bag at all → nothing emitted
  });
});

describe('human filenames (CONNECT-7, CANON-6/7)', () => {
  it('slugifies the kind directory segment (still lowercase — only the leaf is the human name)', () => {
    // slugify stays the lowercase-kebab treatment, but COMPOSE-6 confines it to the kind DIR;
    // the leaf filename no longer goes through it (see entityFileName below).
    expect(slugify('Steve Jobs')).toBe('steve-jobs');
    expect(slugify('Q3 Budget (2026)!')).toBe('q3-budget-2026');
    expect(slugify('   ')).toBe('unnamed');
  });

  // COMPOSE-6 (SPEC-0046) / PRIN-24: the leaf is the natural human name — real case + spaces — NOT a
  // kebab-slug. Only path/Obsidian-illegal chars are stripped; case and hyphens are preserved.
  describe('entityFileName (COMPOSE-6 — human leaf, real case + spaces)', () => {
    it('preserves real case and spaces (NOT a kebab-slug)', () => {
      expect(entityFileName('Steve Jobs')).toBe('Steve Jobs');
      // Regression vs the old slugify: this used to be 'steve-jobs' — case + space are now kept.
      expect(entityFileName('Steve Jobs')).not.toBe('steve-jobs');
    });
    it('preserves intrinsic case (acronyms / mixed-case / lowercase particles survive)', () => {
      expect(entityFileName('iPhone')).toBe('iPhone');
      expect(entityFileName('NASA')).toBe('NASA');
      expect(entityFileName('John von Neumann')).toBe('John von Neumann');
    });
    it('keeps hyphens and other in-name punctuation that the filesystem allows', () => {
      expect(entityFileName('Coca-Cola')).toBe('Coca-Cola');
      expect(entityFileName('Q3 Budget (2026)')).toBe('Q3 Budget (2026)');
      expect(entityFileName('AT&T')).toBe('AT&T');
    });
    it('strips characters a path / Obsidian wikilink cannot hold, collapsing the gap', () => {
      expect(entityFileName('AC/DC')).toBe('AC DC'); // path separator
      expect(entityFileName('Foo: Bar')).toBe('Foo Bar'); // colon
      expect(entityFileName('a#b^c[d]e|f')).toBe('a b c d e f'); // wikilink-significant
      expect(entityFileName('a*b?c"d<e>f')).toBe('a b c d e f');
    });
    it('strips control characters', () => {
      expect(entityFileName('Hello World')).toBe('Hello World');
    });
    it('trims leading dots/spaces (no hidden file) and trailing dots/spaces (Windows hazard)', () => {
      expect(entityFileName('  .hidden  ')).toBe('hidden');
      expect(entityFileName('trailing.')).toBe('trailing');
    });
    it('falls back to "Unnamed" when nothing printable survives', () => {
      expect(entityFileName('   ')).toBe('Unnamed');
      expect(entityFileName('///')).toBe('Unnamed');
      expect(entityFileName('...')).toBe('Unnamed');
    });
    it('caps an over-long name (filesystem leaf limit) without a dangling space', () => {
      const long = 'A'.repeat(200);
      const out = entityFileName(long);
      expect(out.length).toBeLessThanOrEqual(120);
      expect(out).not.toMatch(/\s$/);
    });
  });

  it('produces entities/<kind>/<Human Name>.md (COMPOSE-6 — leaf is the human name, kind dir lowercase)', () => {
    // Fails-before/passes-after for COMPOSE-6: this was 'entities/person/steve-jobs.md'.
    expect(entityFileRel('person', 'Steve Jobs', '01JENT')).toBe('entities/person/Steve Jobs.md');
    // The KIND directory stays a lowercase slug even when the leaf is human (spec §2 path).
    expect(entityFileRel('Public Company', 'Apple', '01JENT')).toBe('entities/public-company/Apple.md');
  });
  it('disambiguates a within-kind collision with a short id suffix — never a ULID filename (CANON-7)', () => {
    const taken = new Set(['entities/person/Steve Jobs.md']);
    const rel = entityFileRel('person', 'Steve Jobs', '01JABCDEF', taken);
    expect(rel).toBe('entities/person/Steve Jobs (01jabc).md');
    expect(rel).not.toMatch(/01JABCDEF\.md$/);
    expect(rel).not.toMatch(/\/[0-9A-Za-z]{10,}\.md$/); // not a ULID-only leaf
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
