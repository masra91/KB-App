// The views the navigation shell registers in v1 (SPEC-0017 SHELL-3).
//
// This is pure metadata (no DOM) so it can be asserted in the node tier alongside
// navModel (SHELL-6). The DOM mount functions are wired by id in shell.ts.

import type { NavView } from './navModel';

/** Stable view ids — referenced by the shell's mount map and by tests. */
export const VIEW_CAPTURE = 'capture';
export const VIEW_REVIEWS = 'reviews';
export const VIEW_PLACEHOLDER = 'placeholder';
export const VIEW_SETTINGS = 'settings';

/**
 * The v1 views, in rail order. Capture is first and is the default on launch (SHELL-4):
 * launch always lands on Capture, not the last-open view — a deliberate behavior recorded
 * in SPEC-0017 §5. Reviews is the "needs you" queue (SPEC-0018 REVIEW-10).
 */
export const NAV_VIEWS: NavView[] = [
  { id: VIEW_CAPTURE, label: 'Capture', icon: '📥' },
  { id: VIEW_REVIEWS, label: 'Reviews', icon: '🔍' },
  { id: VIEW_PLACEHOLDER, label: 'Coming soon', icon: '✨' },
  { id: VIEW_SETTINGS, label: 'Settings', icon: '⚙️' },
];

/** The view active on launch (SHELL-4). */
export const DEFAULT_VIEW_ID = VIEW_CAPTURE;
