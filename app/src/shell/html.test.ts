// esc() null-safety (REVIEW-19 / ENG-15/16). esc() is the shared interpolation helper for every
// data-rendering view; a renderer formats pipeline-/agent-produced data whose optional/derived fields
// can be null/undefined on legacy/partial records. A raw `.replace` on such a value threw inside a
// `.map` and blanked an ENTIRE list ("Loading… forever") — so esc MUST tolerate null/undefined/non-string.
import { describe, it, expect } from 'vitest';
import { esc, baseName, emptyState } from './html';

describe('esc — null-safe interpolation (ENG-16)', () => {
  it('returns "" for null / undefined (never throws — the title:null crash class)', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('escapes the five HTML-significant characters', () => {
    expect(esc(`<a href="x" & 'y'>`)).toBe('&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;');
  });

  it('passes ordinary text through unchanged', () => {
    expect(esc('Jordan')).toBe('Jordan');
    expect(esc('')).toBe('');
  });

  it('coerces a non-string (malformed field) to string rather than throwing', () => {
    expect(esc(42 as unknown as string)).toBe('42');
    expect(esc(true as unknown as string)).toBe('true');
  });
});

describe('baseName', () => {
  it('returns the last path segment, friendly fallback when empty', () => {
    expect(baseName('/Users/me/My Vault')).toBe('My Vault');
    expect(baseName('')).toBe('My KB');
  });
});

describe('emptyState — branded empty primitive (#406)', () => {
  it('renders the .viz-empty primitive with a Spectral-voice title', () => {
    const h = emptyState({ title: 'Nothing needs you right now.' });
    expect(h).toContain('class="viz-empty"');
    expect(h).toContain('class="viz-empty__title viz-voice"');
    expect(h).toContain('Nothing needs you right now.');
  });

  it('defaults to the crystalline mark (aria-hidden), and omits it on null/empty', () => {
    expect(emptyState({ title: 'x' })).toContain('class="viz-empty__mark" aria-hidden="true">◇<');
    expect(emptyState({ title: 'x', glyph: '🎉' })).toContain('aria-hidden="true">🎉<');
    expect(emptyState({ title: 'x', glyph: null })).not.toContain('viz-empty__mark');
    expect(emptyState({ title: 'x', glyph: '' })).not.toContain('viz-empty__mark');
  });

  it('renders body only when present', () => {
    expect(emptyState({ title: 'x', body: 'Reviews land here.' })).toContain('class="viz-empty__body">Reviews land here.');
    expect(emptyState({ title: 'x' })).not.toContain('viz-empty__body');
  });

  it('wraps a caller-built action when present, omits it otherwise', () => {
    const h = emptyState({ title: 'x', action: '<button class="viz-btn">Add a feed</button>' });
    expect(h).toContain('class="viz-empty__action"><button class="viz-btn">Add a feed</button>');
    expect(emptyState({ title: 'x' })).not.toContain('viz-empty__action');
  });

  it('escapes title/body/glyph (ENG-16) but passes action html through (trusted)', () => {
    const h = emptyState({ title: '<x>', body: `a & "b"`, glyph: '<g>', action: '<button>ok</button>' });
    expect(h).toContain('&lt;x&gt;');
    expect(h).toContain('a &amp; &quot;b&quot;');
    expect(h).toContain('aria-hidden="true">&lt;g&gt;<');
    expect(h).toContain('<button>ok</button>'); // action is trusted, not escaped
  });

  it('compact mode (#406): toggles --compact, drops the default mark + the Spectral voice class', () => {
    const c = emptyState({ compact: true, title: 'No feeds yet.', body: 'Add one below.' });
    expect(c).toContain('class="viz-empty viz-empty--compact"');
    expect(c).not.toContain('viz-empty__mark'); // compact drops the default crystalline mark
    expect(c).toContain('class="viz-empty__title">No feeds yet.'); // title is Inter (no viz-voice), not a hero
    expect(c).not.toContain('viz-voice');
    // hero (non-compact) keeps the mark + the voice title
    const hero = emptyState({ title: 'Nothing here.' });
    expect(hero).toContain('viz-empty__mark');
    expect(hero).toContain('class="viz-empty__title viz-voice"');
    // an explicit glyph still renders in compact (DL-1: "or shrink to inline glyph")
    expect(emptyState({ compact: true, title: 'x', glyph: '✓' })).toContain('viz-empty__mark');
  });
});
