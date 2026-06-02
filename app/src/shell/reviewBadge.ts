// Review-count badge for the Reviews nav item (SPEC-0027 PANEL-8) — the "needs you" count is
// visible from anywhere in the shell, including the Manage section, and the Reviews rail item is the
// link to the queue (clicking it navigates). Pure (DOM-free) so the count/label logic is node-tested
// per SHELL-6; shell.ts is the thin layer that paints it onto the nav item + polls it live.

/** The badge text for `count` open reviews — empty when none, capped at "99+" so the pill stays small. */
export function reviewBadgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** An accessible label for the count (announced on the Reviews nav item), empty when none. */
export function reviewBadgeAria(count: number): string {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return '';
  return `${n} ${n === 1 ? 'review needs' : 'reviews need'} your attention`;
}
