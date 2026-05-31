// App Navigation Shell — selection model (SPEC-0017 SHELL-2/5/6).
//
// SHELL-6: this module is the navigation/selection logic and MUST stay free of any
// Electron or DOM dependency, so it can be unit-tested in the node tier (SPEC-0012
// TEST-5 keeps the component tier reserved — no jsdom harness). The DOM shell
// (shell.ts) is a thin layer that renders whatever this model says is active.

export interface NavView {
  /** Stable, unique id used to address the view. */
  id: string;
  /** Human label shown in the navigation rail. */
  label: string;
  /** Optional leading glyph for the rail. */
  icon?: string;
}

export interface NavModel {
  /** The registered views, in display order. */
  readonly views: readonly NavView[];
  /** Currently active view id (exactly one is always active — SHELL-2). */
  readonly activeId: string;
  /** The currently active view. */
  getActive(): NavView;
  /** Whether `id` is the active view. */
  isActive(id: string): boolean;
  /**
   * Make `id` the active view. Returns true if the active view changed.
   * An unknown id is a no-op (returns false) so the "exactly one active"
   * invariant (SHELL-2) is never violated.
   */
  select(id: string): boolean;
  /** Subscribe to active-view changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/**
 * Create a navigation model over an ordered list of views (SHELL-5: adding a view
 * is a single registry entry — no other view needs editing). `defaultId` picks the
 * view active on creation; it defaults to the first view.
 */
export function createNavModel(views: NavView[], defaultId?: string): NavModel {
  if (views.length === 0) {
    throw new Error('createNavModel: at least one view is required');
  }
  const ids = new Set<string>();
  for (const v of views) {
    if (ids.has(v.id)) throw new Error(`createNavModel: duplicate view id "${v.id}"`);
    ids.add(v.id);
  }
  const defaulted = defaultId ?? views[0].id;
  if (!ids.has(defaulted)) {
    throw new Error(`createNavModel: defaultId "${defaulted}" is not a registered view`);
  }

  const frozen = Object.freeze([...views]);
  const listeners = new Set<() => void>();
  let activeId = defaulted;

  return {
    views: frozen,
    get activeId() {
      return activeId;
    },
    getActive() {
      return frozen.find((v) => v.id === activeId)!;
    },
    isActive(id) {
      return id === activeId;
    },
    select(id) {
      if (!ids.has(id) || id === activeId) return false;
      activeId = id;
      for (const fn of listeners) fn();
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
