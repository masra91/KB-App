// The views the navigation shell registers in v1 (SPEC-0017 SHELL-3).
//
// This is pure metadata (no DOM) so it can be asserted in the node tier alongside
// navModel (SHELL-6). The DOM mount functions are wired by id in shell.ts.

import type { NavView } from './navModel';

/** Stable view ids — referenced by the shell's mount map and by tests. */
export const VIEW_CAPTURE = 'capture';
export const VIEW_REVIEWS = 'reviews';
export const VIEW_ACTIVITY = 'activity';
export const VIEW_STATUS = 'status';
export const VIEW_ASK = 'ask';
// Control Panel — the "Manage" section of sibling views (SPEC-0027 PANEL-1).
export const VIEW_JOBS = 'jobs';
export const VIEW_AGENTS = 'agents';
export const VIEW_RESEARCHERS = 'researchers';
export const VIEW_SOURCES = 'sources';
export const VIEW_SETTINGS = 'settings';

/** The rail section heading the Control Panel views sit under (SPEC-0027 PANEL-1). */
export const GROUP_MANAGE = 'Manage';

/**
 * The v1 views, in rail order. Capture is first and is the default on launch (SHELL-4):
 * launch always lands on Capture, not the last-open view — a deliberate behavior recorded
 * in SPEC-0017 §5. Reviews is the "needs you" queue (SPEC-0018 REVIEW-10); Activity is the
 * read-only audit observatory (SPEC-0029 AUDIT-9, a top-level sibling next to Reviews); Ask is
 * grounded recall (SPEC-0026). The Control Panel (SPEC-0027) adds a "Manage" section of sibling
 * views — Jobs, Agents, Researchers, Sources, Settings — to observe + configure the machine;
 * Settings moves under Manage (elevated from the display-only stub, SHELL-7 → PANEL-5).
 *
 * The SHELL-3 "neutral placeholder" was a v1 scaffold proving the shell carries more than one view;
 * it's retired now that the real view set (Capture/Reviews/Activity/Ask + the Manage section) proves
 * that directly — no dead "Coming soon" item in the rail (SPEC-0017 SHELL-3 amended).
 */
export const NAV_VIEWS: NavView[] = [
  { id: VIEW_CAPTURE, label: 'Capture', icon: '📥' },
  { id: VIEW_REVIEWS, label: 'Reviews', icon: '🔍' },
  { id: VIEW_ACTIVITY, label: 'Activity', icon: '📜' },
  { id: VIEW_STATUS, label: 'Status', icon: '📊' },
  { id: VIEW_ASK, label: 'Ask', icon: '💬' },
  { id: VIEW_JOBS, label: 'Jobs', icon: '🛠️', group: GROUP_MANAGE },
  { id: VIEW_AGENTS, label: 'Agents', icon: '🤖', group: GROUP_MANAGE },
  { id: VIEW_RESEARCHERS, label: 'Researchers', icon: '🔬', group: GROUP_MANAGE },
  { id: VIEW_SOURCES, label: 'Sources', icon: '🔌', group: GROUP_MANAGE },
  { id: VIEW_SETTINGS, label: 'Settings', icon: '⚙️', group: GROUP_MANAGE },
];

/** The view active on launch (SHELL-4). */
export const DEFAULT_VIEW_ID = VIEW_CAPTURE;
