// SPEC-0026 ASK-14 — the pure citation render-target transforms (Obsidian URI + wikilink). Node tier.
import { describe, it, expect } from 'vitest';
import { obsidianOpenUri, wikilinkTarget } from './citationLink';

describe('obsidianOpenUri (ASK-14 — Ask-panel deep-link)', () => {
  it('builds an obsidian://open URI with the path percent-encoded', () => {
    expect(obsidianOpenUri('/Users/me/My Vault/entities/person/ada-lovelace.md')).toBe(
      'obsidian://open?path=%2FUsers%2Fme%2FMy%20Vault%2Fentities%2Fperson%2Fada-lovelace.md',
    );
  });

  it('encodes characters that would break the URI or smuggle query params (#, ?, &, spaces)', () => {
    const uri = obsidianOpenUri('/v/a b/c#d?e&f.md');
    // the only literal `?` is the URI's own query separator; nothing from the path leaks raw
    expect(uri.indexOf('?')).toBe('obsidian://open'.length);
    expect(uri).not.toContain('#');
    expect(uri).not.toContain(' ');
    expect(uri).toContain('%23'); // #
    expect(uri).toContain('%3F'); // ?
    expect(uri).toContain('%26'); // &
    expect(uri).toContain('%20'); // space
  });

  it('round-trips: decoding the path query param recovers the absolute path', () => {
    const abs = '/Users/me/Notes & Refs/claims/x.md';
    const uri = obsidianOpenUri(abs);
    const decoded = decodeURIComponent(uri.slice('obsidian://open?path='.length));
    expect(decoded).toBe(abs);
  });
});

describe('wikilinkTarget (ASK-14 — saved-Output surface)', () => {
  it('uses the label for an ENTITY (the display name is the link text)', () => {
    expect(wikilinkTarget('entity', 'entities/person/ada-lovelace.md', 'Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('falls back to the note basename (no extension) when an entity has no label', () => {
    expect(wikilinkTarget('entity', 'entities/x/grace-hopper.md')).toBe('grace-hopper');
  });

  it('links a CLAIM by its note basename (not the label — the label is descriptive prose)', () => {
    expect(wikilinkTarget('claim', 'claims/person/ada/c1.md', 'first programmer')).toBe('c1');
  });

  it('returns null for a SOURCE — a directory has no single note to wikilink', () => {
    expect(wikilinkTarget('source', 'sources/2026/01/abc/')).toBeNull();
  });
});
