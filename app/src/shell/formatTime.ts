// Friendly timestamp rendering for the UI (dogfood #3). The views stored/showed raw ISO-8601
// (`2026-06-02T00:01:00.000Z`) — accurate but unreadable. This formats a moment for *display only*:
// recent times relative ("2 min ago"), older ones as a short local date/time. PURE — `now` is
// injectable so it's deterministic in tests (and so it never depends on a forbidden ambient clock in
// a test context). It never mutates anything; callers keep the canonical ISO string they were given.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Render an ISO timestamp for a human. `null`/empty → an em-dash; an unparseable string passes
 * through unchanged (better to show the raw value than to drop information). Within a week we show a
 * coarse relative time ("just now", "5 min ago", "3 hr ago", "2 days ago"); older than that, a short
 * absolute local date. `nowMs` defaults to the current time (injected in tests).
 */
export function formatTimestamp(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso; // not a date we understand — show it as-is rather than hide it
  const diff = nowMs - t;
  if (diff < 0) return shortDate(t); // a future stamp — just show the date, no negative "ago"
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hr ago`;
  if (diff < 7 * DAY) {
    const d = Math.floor(diff / DAY);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return shortDate(t);
}

/** A short, locale-aware absolute date+time (e.g. "Jun 2, 12:01 PM"). */
function shortDate(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
