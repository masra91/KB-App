// esc() null-safety (REVIEW-19 / ENG-15/16). esc() is the shared interpolation helper for every
// data-rendering view; a renderer formats pipeline-/agent-produced data whose optional/derived fields
// can be null/undefined on legacy/partial records. A raw `.replace` on such a value threw inside a
// `.map` and blanked an ENTIRE list ("Loading… forever") — so esc MUST tolerate null/undefined/non-string.
import { describe, it, expect } from 'vitest';
import { esc, baseName } from './html';

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
