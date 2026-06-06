// @vitest-environment happy-dom
//
// DESIGN-SHOWCASE — the primitive gallery, component tier. This is the deterministic GATE-2 coverage
// guard (the e2e snapshot pins the pixels; this asserts the §3 render MATRIX is fully present + composes
// the SHIPPED `.viz-*` classes, with no IPC). Faithful-mirror: documented primitive gaps are rendered as
// flagged cells, asserted here so a future primitive addition (closing a gap) is a visible test change.
import { describe, it, expect, beforeEach } from 'vitest';
import { mountShowcase } from './showcaseView';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="r"></div>';
  root = document.getElementById('r')!;
  mountShowcase(root); // synchronous, no IPC/pipeline — the whole point
});

describe('Showcase — structure + no live dependency', () => {
  it('mounts statically: 4 primitive sections, on .viz-surface, with zero IPC and no native <select>', () => {
    expect(root.querySelector('.showcase.viz-surface')).not.toBeNull();
    expect(root.querySelectorAll('.showcase-section')).toHaveLength(4);
    expect(root.querySelector('.showcase-title')?.textContent).toContain('Design-System Showcase');
    expect(root.querySelectorAll('select')).toHaveLength(0); // instrument language — never a native dropdown
  });

  it('every cell carries a mono caption (so a snapshot diff names the exact variant/state)', () => {
    const cells = Array.from(root.querySelectorAll('.showcase-cell'));
    expect(cells.length).toBeGreaterThan(20);
    for (const c of cells) expect(c.querySelector('.showcase-cap')?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

describe('Showcase — Button matrix (§3)', () => {
  it('renders every variant × the forced states, composing shipped .viz-btn classes', () => {
    const btns = root.querySelector('.showcase-section')!; // first section = Button
    expect(btns.querySelector('.viz-btn:not(.viz-btn--primary):not(.viz-btn--danger):not(.viz-btn--ghost)')).not.toBeNull(); // default
    expect(btns.querySelector('.viz-btn--primary')).not.toBeNull();
    expect(btns.querySelector('.viz-btn--danger')).not.toBeNull();
    expect(btns.querySelector('.viz-btn--ghost')).not.toBeNull();
    expect(btns.querySelector('.viz-btn--busy')).not.toBeNull();
    expect(btns.querySelector('.viz-btn--sm')).not.toBeNull();
    // forced interaction states (static hooks)
    expect(btns.querySelector('.viz-btn.is-hover')).not.toBeNull();
    expect(btns.querySelector('.viz-btn.is-focus')).not.toBeNull();
    expect(btns.querySelector('.viz-btn[disabled]')).not.toBeNull();
  });
});

describe('Showcase — SegmentedControl matrix (§4)', () => {
  it('renders neutral (resting/active/hover/focus) + clearance at all three temperatures', () => {
    expect(root.querySelectorAll('.viz-seg[role="radiogroup"]').length).toBeGreaterThanOrEqual(7);
    expect(root.querySelector('.viz-seg-opt[aria-checked="true"]')).not.toBeNull(); // active
    expect(root.querySelector('.viz-seg-opt.is-hover')).not.toBeNull();
    expect(root.querySelector('.viz-seg-opt.is-focus')).not.toBeNull();
    for (const temp of ['local-only', 'internal-tenant', 'public-web']) {
      expect(root.querySelector(`.viz-seg-opt--clearance[data-temp="${temp}"][aria-checked="true"]`)).not.toBeNull();
    }
  });
});

describe('Showcase — ConfirmInline matrix (§5)', () => {
  it('renders caution + danger inline confirms and the hidden contract cell', () => {
    expect(root.querySelector('.viz-confirm:not(.viz-confirm--danger)')).not.toBeNull(); // caution (brass)
    expect(root.querySelector('.viz-confirm--danger')).not.toBeNull(); // danger (oxide)
    expect(root.querySelector('.viz-confirm[hidden]')).not.toBeNull(); // proves [hidden]→none
    expect(root.querySelector('.viz-confirm .viz-btn--danger')).not.toBeNull(); // the confirm action
  });
});

describe('Showcase — EditableField matrix (§6)', () => {
  it('renders text/numeric/multiline/duration + focus/dirty/invalid states', () => {
    expect(root.querySelector('input.viz-field__input:not(.viz-field__input--numeric)')).not.toBeNull(); // text
    expect(root.querySelector('.viz-field__input--numeric')).not.toBeNull();
    expect(root.querySelector('textarea.viz-field__input--multiline')).not.toBeNull();
    expect(root.querySelector('.viz-field__input.is-focus')).not.toBeNull(); // focus rule
    expect(root.querySelector('.viz-field__input--invalid')).not.toBeNull(); // invalid (oxide rule)
    // dirty = field + a save Button shown
    expect(root.querySelector('.showcase-inline .viz-btn--primary')).not.toBeNull();
  });
});

describe('Showcase — faithful-mirror: documented primitive GAPS are flagged (not faked)', () => {
  it('flags exactly the 4 spec-vs-shipped gaps with a ⚠ caption naming the missing class', () => {
    const gaps = Array.from(root.querySelectorAll('.showcase-cell--gap')).map((g) => g.querySelector('.showcase-cap--gap')?.textContent ?? '');
    expect(gaps).toHaveLength(4);
    const joined = gaps.join(' | ');
    expect(joined).toContain('.viz-btn--clearance'); // Button clearance-tinted variant not shipped
    expect(joined).toContain('.viz-seg-opt disabled rule'); // SegmentedControl disabled dim not shipped
    expect(joined).toContain('.viz-confirm--dialog'); // ConfirmInline dialog variant not shipped
    expect(joined).toContain('.viz-field__input disabled rule'); // EditableField disabled dim not shipped
    for (const g of gaps) expect(g).toContain('⚠ gap');
    // a gap NEVER invents primitive styling — it only flags; no showcase-only .viz-* override exists
  });
});
