// Guard for SPEC-0057 fixed-light (SUPERSEDES #214). The Vellum app skin is FIXED-LIGHT cream — brand
// §3 "surfaces don't invert; the cream study is the product." The shell no longer tracks the OS:
// #214's `prefers-color-scheme` light/dark override is intentionally removed (Principal-confirmed
// 06-28). Fails-before/passes-after: the dark default + the @media light override are GONE; the single
// :root is the Vellum cream palette aligned to the --viz-* tokens; hover stays tokenized.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, 'index.css'), 'utf8'); // CJS module target → __dirname, not import.meta

describe('app shell is fixed-light Vellum cream (SPEC-0057, supersedes #214)', () => {
  it('is fixed-light: color-scheme is light-only and there is NO prefers-color-scheme override', () => {
    expect(css).toMatch(/color-scheme:\s*light\s*;/);
    expect(css).not.toMatch(/color-scheme:\s*light dark/);
    expect(css).not.toMatch(/@media \(prefers-color-scheme/); // the #214 OS-tracking is removed
  });

  it('the single :root uses the Vellum cream palette, aligned to the --viz-* tokens', () => {
    expect(css).toContain('--bg: #f4efe3');     // Vellum cream  (= --viz-field)
    expect(css).toContain('--fg: #2b2f36');     // Slate Ink     (= --viz-ink)
    expect(css).toContain('--border: #e0d6be'); // Hairline      (= --viz-rule)
    expect(css).toContain('--accent: #3a6e88'); // slate-blue    (= --viz-accent), not framework indigo
    expect(css).toContain('--hover: rgba(0, 0, 0, 0.05)');
  });

  it('the pre-Vellum palette is gone — no framework-indigo accent, no dark-default ground', () => {
    expect(css).not.toContain('#6c8cff');       // framework indigo accent → replaced by slate-blue
    expect(css).not.toContain('--bg: #1e1e22'); // old dark-default ground → gone (fixed-light)
  });

  it('hover washes are tokenized — no hardcoded white :hover background (would die on cream)', () => {
    // A literal rgba(255,255,255,…) :hover background is invisible on the cream ground; route via var(--hover).
    expect(css).not.toMatch(/:hover\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/);
  });
});
