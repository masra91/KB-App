// Guard for #214 (app shell honors prefers-color-scheme — cohesive light + dark). A CSS-only fix still
// gets a regression test per the standing rule: a file-content guard that the bad pattern is gone and
// the intended structure exists. Fails-before: the literal-white-hover assertion failed when the shell
// hardcoded `rgba(255,255,255,…)` washes that vanish on paper; the light-block assertions failed when
// the shell had no `prefers-color-scheme` override (the split-theme bug the Principal flagged).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8');

describe('app shell theme cohesion (#214)', () => {
  it('defines a light-mode override so the shell tracks the OS (not hardcoded dark)', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)/);
  });

  it('the light override flips the shell tokens to the paper palette (aligned to the VIZ light tokens)', () => {
    // These values appear ONLY inside the light-mode block — their presence proves the flip is wired.
    expect(css).toContain('--bg: #f4f1ea');
    expect(css).toContain('--fg: #1c1b18');
    expect(css).toContain('--border: #cfc9bc');
    expect(css).toContain('--hover: rgba(0, 0, 0, 0.05)');
  });

  it('hover washes are tokenized — no hardcoded white :hover background that dies on paper', () => {
    // A literal rgba(255,255,255,…) on a :hover background is invisible in light mode; it must route
    // through var(--hover) so it flips with the scheme. (The `--hover` token definition itself is fine.)
    expect(css).not.toMatch(/:hover\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/);
  });
});
