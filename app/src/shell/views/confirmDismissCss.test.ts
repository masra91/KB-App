// WS1 #1 regression — confirm boxes are shown/hidden by toggling the `hidden` attribute. Their base
// rule sets `display: flex`, which OVERRIDES the browser default `[hidden] { display: none }` — so
// before the fix, setting `hidden` could not actually dismiss the box (felt worse once run-now became
// long-running). The fix restores the hidden contract with an explicit `[hidden] { display: none }` guard.
//
// WS2/WS3: the shared `.viz-confirm` primitive (design-system.css) owns the `display: flex` AND its own
// `[hidden]` guard, and every confirm now composes it — Field-Desk (.rdesk-confirm), Jobs, and (WS3
// DESIGN-LEGACY-VIEWS §3) Settings. The legacy index.css `.confirm` was retired with Settings' migration
// (its final consumer). This test follows the rule to wherever the display lives: a confirm box whose
// base rule sets a non-none `display` MUST carry a `[hidden]` display:none guard.
//
// happy-dom applies no stylesheet, so a layout assertion can't catch this; we assert the CSS SOURCE.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// vitest runs with cwd = the app package root.
const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
const designSystemCss = readFileSync(path.resolve(process.cwd(), 'src/shell/design-system.css'), 'utf8');

// WS3 completeness guard: the legacy index.css `.confirm` MUST be gone (Settings was its last consumer,
// now on .viz-confirm) — leaving it would be dead, drift-prone CSS (rename-completeness rule).
describe('WS3 — legacy .confirm retired from index.css (DESIGN-LEGACY-VIEWS §3)', () => {
  it('no legacy `.confirm` rule remains in index.css', () => {
    expect(indexCss).not.toMatch(/(^|[,}\s])\.confirm\s*(\[hidden\]|\.|\s)*\{/m);
  });
});

/** The `display` value a rule sets, if any (last wins) — naive but sufficient for these flat rules. */
function displayOf(css: string, selector: string): string | null {
  // Match `<selector> { … }` allowing other selectors in the same group (comma list).
  const re = new RegExp(`(^|[,}\\s])${selector.replace(/[.[\]\\]/g, '\\$&')}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m) return null;
  const decls = m[3];
  const d = [...decls.matchAll(/display\s*:\s*([^;]+)\s*;?/g)].pop();
  return d ? d[1].trim() : null;
}

describe('WS1 #1 — confirm boxes honor the `hidden` attribute (CSS guard present)', () => {
  // [css source, confirm selector] — the rule lives wherever the display:flex is declared. Every
  // confirm now composes the shared primitive, so the guard validates it on .viz-confirm.
  for (const [css, cls, where] of [
    [designSystemCss, '.viz-confirm', 'design-system.css'], // the shared ConfirmInline primitive (WS2/WS3)
  ] as const) {
    it(`${cls} sets a non-none display in ${where} (so a [hidden] guard is required)`, () => {
      const base = displayOf(css, cls);
      expect(base).not.toBeNull();
      expect(base).not.toBe('none'); // it's `flex` — this is exactly why the guard is needed
    });

    it(`${cls}[hidden] is guarded to display: none in ${where} (REGRESSION: hidden must dismiss the box)`, () => {
      expect(displayOf(css, `${cls}[hidden]`)).toBe('none');
    });
  }
});
