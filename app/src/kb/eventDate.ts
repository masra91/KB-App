// Event-date normalization (SPEC-0025 META Slice-2 / META-2) — the curated **event-time** facet that
// enables the timeline. Representation ruling (b): a fuzzy event date is written as a FULL Obsidian-native
// `date` Property (`founded: 1976-01-01`) PLUS a sibling `*_precision` marker (`founded_precision: year`).
// The full date keeps Bases/graph date-SORT + range working (the headline value); the precision flag means
// nothing reads the synthetic month/day as real — a year-only "founded 1976" stays honestly year-precise.
//
// Pure + dependency-free (no Date parsing libs): we accept only zero-padded ISO granularities
// (`YYYY` | `YYYY-MM` | `YYYY-MM-DD`) and INFER precision from the value's granularity, padding to a full
// date. A non-ISO / unparseable value is dropped (null) — like a bad tag, never a malformed Property.

export type EventDatePrecision = 'year' | 'month' | 'day';

/** A normalized entity event date: a slug `label` (the Property key), a full `date` (YYYY-MM-DD, padded),
 *  and the honest `precision` of the original value. */
export interface EventDate {
  label: string;
  date: string; // YYYY-MM-DD — padded to a full date (synthetic parts flagged by `precision`)
  precision: EventDatePrecision;
}

/** Normalize an event-date label to an Obsidian Property key: lowercase, spaces/underscores → `-`, keep
 *  only letters/digits/`-`, collapse + trim. `Founded` → `founded`, `First Released` → `first-released`.
 *  Returns '' for a label that normalizes to nothing (the caller drops it). Never produces a `_precision`
 *  collision: a `-` separator is used, and a trailing `_precision` is only ever appended, never authored. */
export function normalizeEventLabel(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The frontmatter key holding an event date's precision marker (ruling b). */
export function eventPrecisionKey(label: string): string {
  return `${label}_precision`;
}

/**
 * Normalize one coined event date (`{label, value}`) → a full-date + inferred precision, or null when the
 * label or value is unusable. Precision is the value's GRANULARITY (`1976` → year, `1976-04` → month,
 * `1976-04-01` → day), so it's faithful regardless of any precision hint the agent sends. The date is padded
 * to `YYYY-MM-DD` (month/day default to `01`) so it is a valid Obsidian `date` Property. Calendar-invalid
 * months/days (`-13`, `-32`) are rejected (null) rather than written as a broken date.
 */
export function normalizeEventDate(rawLabel: string, rawValue: string): EventDate | null {
  const label = normalizeEventLabel(rawLabel);
  if (!label) return null;
  const m = rawValue.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return null;
  const [, year, mo, day] = m;
  if (mo !== undefined && (Number(mo) < 1 || Number(mo) > 12)) return null;
  if (day !== undefined && (Number(day) < 1 || Number(day) > 31)) return null;
  if (day !== undefined) return { label, date: `${year}-${mo}-${day}`, precision: 'day' };
  if (mo !== undefined) return { label, date: `${year}-${mo}-01`, precision: 'month' };
  return { label, date: `${year}-01-01`, precision: 'year' };
}

/** Normalize a list of coined dates, dropping unusable ones and DEDUPING by label (first wins — caller
 *  pre-orders canonical/fresh before losers). Output is sorted by label for deterministic frontmatter. */
export function normalizeEventDates(raw: ReadonlyArray<{ label: string; value: string }>): EventDate[] {
  const byLabel = new Map<string, EventDate>();
  for (const d of raw) {
    const norm = normalizeEventDate(d.label, d.value);
    if (norm && !byLabel.has(norm.label)) byLabel.set(norm.label, norm);
  }
  return [...byLabel.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
