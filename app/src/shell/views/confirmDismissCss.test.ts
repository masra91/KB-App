// WS1 #1 regression — the inline confirm boxes (Jobs `.confirm` + Researcher desk `.rdesk-confirm`)
// are shown/hidden by toggling the `hidden` attribute. Their base rule sets `display: flex`, which
// OVERRIDES the browser default `[hidden] { display: none }` — so before the fix, setting `hidden`
// could not actually dismiss the box (felt worse once run-now became long-running). The fix restores
// the hidden contract with an explicit `[hidden] { display: none }` guard.
//
// happy-dom applies no stylesheet, so a layout assertion can't catch this; we assert the CSS SOURCE
// directly. Tests the CLASS: a confirm box whose base rule sets a non-none `display` MUST carry a
// `[hidden]` display:none guard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// vitest runs with cwd = the app package root, where `src/index.css` lives.
const css = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The `display` value a rule sets, if any (last wins) — naive but sufficient for these flat rules. */
function displayOf(selector: string): string | null {
  // Match `<selector> { … }` allowing other selectors in the same group (comma list).
  const re = new RegExp(`(^|[,}\\s])${selector.replace(/[.[\]\\]/g, '\\$&')}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m) return null;
  const decls = m[3];
  const d = [...decls.matchAll(/display\s*:\s*([^;]+)\s*;?/g)].pop();
  return d ? d[1].trim() : null;
}

describe('WS1 #1 — confirm boxes honor the `hidden` attribute (CSS guard present)', () => {
  for (const cls of ['.confirm', '.rdesk-confirm']) {
    it(`${cls} sets a non-none display (so a [hidden] guard is required)`, () => {
      const base = displayOf(cls);
      expect(base).not.toBeNull();
      expect(base).not.toBe('none'); // it's `flex` — this is exactly why the guard is needed
    });

    it(`${cls}[hidden] is guarded to display: none (REGRESSION: hidden must dismiss the box)`, () => {
      expect(displayOf(`${cls}[hidden]`)).toBe('none');
    });
  }
});
