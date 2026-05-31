// SPEC-0017 SHELL-2/3/4/5/6 — navigation/selection model.
// Runs in the node tier (no DOM), which is itself the proof of SHELL-6.
import { describe, it, expect, vi } from 'vitest';
import { createNavModel, type NavView } from './navModel';
import { NAV_VIEWS, DEFAULT_VIEW_ID, VIEW_CAPTURE, VIEW_REVIEWS, VIEW_PLACEHOLDER, VIEW_SETTINGS } from './views';

const sample: NavView[] = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
];

describe('NAV_VIEWS registry (SHELL-3)', () => {
  it('registers Capture, Reviews, placeholder, and Settings, in rail order (REVIEW-10 added via SHELL-5)', () => {
    expect(NAV_VIEWS.map((v) => v.id)).toEqual([VIEW_CAPTURE, VIEW_REVIEWS, VIEW_PLACEHOLDER, VIEW_SETTINGS]);
  });

  it('every view has a non-empty label (SHELL-3)', () => {
    for (const v of NAV_VIEWS) expect(v.label.length).toBeGreaterThan(0);
  });
});

describe('default view (SHELL-4)', () => {
  it('Capture is the default on launch', () => {
    expect(DEFAULT_VIEW_ID).toBe(VIEW_CAPTURE);
    const model = createNavModel(NAV_VIEWS, DEFAULT_VIEW_ID);
    expect(model.getActive().id).toBe(VIEW_CAPTURE);
  });

  it('defaults to the first view when no defaultId is given', () => {
    expect(createNavModel(sample).getActive().id).toBe('a');
  });
});

describe('selection invariant (SHELL-2)', () => {
  it('exactly one view is active at a time', () => {
    const model = createNavModel(sample);
    const activeCount = () => sample.filter((v) => model.isActive(v.id)).length;
    expect(activeCount()).toBe(1);
    model.select('b');
    expect(activeCount()).toBe(1);
    expect(model.getActive().id).toBe('b');
  });

  it('selecting a different view changes the active view and reports the change', () => {
    const model = createNavModel(sample);
    expect(model.select('c')).toBe(true);
    expect(model.activeId).toBe('c');
  });

  it('selecting the already-active view is a no-op', () => {
    const model = createNavModel(sample, 'b');
    expect(model.select('b')).toBe(false);
    expect(model.activeId).toBe('b');
  });

  it('selecting an unknown id never breaks the one-active invariant', () => {
    const model = createNavModel(sample, 'a');
    expect(model.select('nope')).toBe(false);
    expect(model.activeId).toBe('a');
    expect(sample.filter((v) => model.isActive(v.id)).length).toBe(1);
  });
});

describe('extensible registry (SHELL-5)', () => {
  it('adding a view is a single entry; existing views and selection are unaffected', () => {
    const extended: NavView[] = [...sample, { id: 'd', label: 'D' }];
    const model = createNavModel(extended, 'b');
    // existing selection still valid
    expect(model.getActive().id).toBe('b');
    // the new view is selectable with no change to the others
    expect(model.select('d')).toBe(true);
    expect(model.getActive().id).toBe('d');
    expect(model.views.map((v) => v.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('change notification (drives the thin DOM layer — SHELL-6)', () => {
  it('fires listeners on change and not on a no-op, and can unsubscribe', () => {
    const model = createNavModel(sample);
    const spy = vi.fn();
    const off = model.onChange(spy);
    model.select('b'); // change
    model.select('b'); // no-op
    model.select('zzz'); // unknown → no-op
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    model.select('c');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('construction guards', () => {
  it('rejects an empty view list', () => {
    expect(() => createNavModel([])).toThrow(/at least one view/);
  });

  it('rejects duplicate view ids', () => {
    expect(() => createNavModel([{ id: 'x', label: 'X' }, { id: 'x', label: 'X2' }])).toThrow(/duplicate/);
  });

  it('rejects a defaultId that is not registered', () => {
    expect(() => createNavModel(sample, 'missing')).toThrow(/not a registered view/);
  });
});

describe('runs without a DOM (SHELL-6)', () => {
  it('has no document dependency in the node tier', () => {
    expect(typeof document).toBe('undefined');
    expect(() => createNavModel(NAV_VIEWS, DEFAULT_VIEW_ID).getActive()).not.toThrow();
  });
});
