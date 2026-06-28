// Today projection builder (SPEC-0058 STATE-7) — PURE, DOM-free view-model logic (like jobsPanel /
// researchersPanel). It COMPOSES already-maintained projection inputs into the exact `TodayProjection`
// shape the v2 command-center home draws (one projection read, no live vault scan — STATE-1). The
// main-side wiring (slice 2) maps the real graph/activity/registry/status projections into `TodayInputs`
// and feeds this; the renderer (slice 3) wires the output into Design-Lead's CSS. Keeping the assembly
// pure here means the stat-deltas / salutation / line-meta / decision-ordering / health-thresholds are
// all unit-testable without a backend, timer, or DOM.
import type {
  TodayProjection,
  TodayStat,
  TodayDecision,
  TodayHealthRow,
  TodayActivityItem,
  TodayStation,
} from './types';

/** The precise upstream fields Today needs — mapped from existing projections by the main-side wiring. */
export interface TodayInputs {
  /** The Principal's name (instance config); omitted → greeting drops the comma. */
  name?: string;
  /** Headline totals (from conversion counts + the graph projection). */
  counts: { sources: number; claims: number; entities: number; connections: number };
  /** How many of each were created "today" (from the HEAD-keyed audit index, windowed). */
  todayDeltas: { sources: number; claims: number; entities: number; connections: number };
  /** The pipeline ribbon, already state-resolved upstream (from pipeline status). */
  stations: TodayStation[];
  /** Total items in flight across the pipeline now. */
  inFlight: number;
  /** Age of the most recent Compose, in ms (null → never composed). */
  lastComposedAgoMs: number | null;
  /** Recent curated activity, newest-first (from the activity projection). */
  activity: Array<{ kind: TodayActivityItem['kind']; text: string; ref?: string; agoMs: number }>;
  /** Open "needs you" counts. */
  openReviews: number;
  contradictions: number;
  /** Health-glance metrics — the SAME dimensions as the real Health projection (dangling/orphans/thin);
   *  grounding-coverage is deferred (not computed), so it's intentionally not surfaced. */
  health: { dangling: number; orphans: number; thin: number };
  /** How many items moved through the pipeline recently (drives the calm subtitle). */
  movedRecently: number;
}

const MAX_ACTIVITY = 5;

/** Build the Today projection from composed inputs at `nowMs` (injected so it's clock-free/testable). */
export function buildTodayProjection(inputs: TodayInputs, nowMs: number): TodayProjection {
  return {
    greeting: { salutation: salutationFor(nowMs), ...(isNonEmpty(inputs.name) ? { name: inputs.name!.trim() } : {}) },
    subtitle: subtitleFor(inputs),
    line: { meta: lineMeta(inputs), stations: inputs.stations },
    stats: buildStats(inputs),
    activity: inputs.activity.slice(0, MAX_ACTIVITY).map((a) => ({ kind: a.kind, text: a.text, ...(isNonEmpty(a.ref) ? { ref: a.ref } : {}), when: compactAgo(a.agoMs) })),
    decisions: buildDecisions(inputs),
    health: buildHealth(inputs),
  };
}

/** Time-of-day salutation (local hour from the injected clock). */
export function salutationFor(nowMs: number): string {
  const h = new Date(nowMs).getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The calm one-line state-of-the-library subtitle. */
function subtitleFor(inputs: TodayInputs): string {
  const moved = inputs.movedRecently;
  const movedClause = moved <= 0 ? 'nothing moved while you were away' : `${moved} thing${moved === 1 ? '' : 's'} moved through while you were away`;
  // "quiet and current" when nothing needs you; otherwise lead honest but unalarmed.
  const calm = inputs.openReviews + inputs.contradictions === 0;
  return calm ? `Your library is quiet and current — ${movedClause}.` : `Your library is current — ${movedClause}.`;
}

/** "2 in flight · last composed 6m ago" — honest about an empty pipeline / never-composed. */
function lineMeta(inputs: TodayInputs): string {
  const flight = inputs.inFlight <= 0 ? 'nothing in flight' : `${inputs.inFlight} in flight`;
  const composed = inputs.lastComposedAgoMs == null ? 'nothing composed yet' : `last composed ${compactAgo(inputs.lastComposedAgoMs)} ago`;
  return `${flight} · ${composed}`;
}

const STAT_LABELS: Record<TodayStat['key'], string> = { sources: 'Sources', claims: 'Claims', entities: 'Entities', connections: 'Connections' };

function buildStats(inputs: TodayInputs): TodayStat[] {
  const keys: TodayStat['key'][] = ['sources', 'claims', 'entities', 'connections'];
  return keys.map((key) => {
    const value = safeCount(inputs.counts[key]);
    const d = safeCount(inputs.todayDeltas[key]);
    return { key, label: STAT_LABELS[key], value, delta: d > 0 ? { dir: 'up' as const, text: `+${d} today` } : { dir: 'flat' as const, text: 'stable' } };
  });
}

/** A non-negative integer, NaN/undefined/garbage → 0 (ENG-15/16: never leak NaN/undefined into a count). */
function safeCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Needs-you cards, contradiction-first (a contradiction is the sharper call), then waiting reviews. Empty
 *  array → the view shows the calm "nothing needs you" rest state. */
function buildDecisions(inputs: TodayInputs): TodayDecision[] {
  const out: TodayDecision[] = [];
  if (inputs.contradictions > 0) {
    out.push({
      kind: 'contradiction',
      title: inputs.contradictions === 1 ? 'A contradiction surfaced' : `${inputs.contradictions} contradictions surfaced`,
      body: 'Sources disagree. Pick the canonical claim.',
      action: 'Resolve',
      targetView: 'reviews',
    });
  }
  if (inputs.openReviews > 0) {
    out.push({
      kind: 'review',
      title: inputs.openReviews === 1 ? '1 review waiting' : `${inputs.openReviews} reviews waiting`,
      body: "Entities the librarian wasn't sure how to merge.",
      action: 'Review',
      targetView: 'reviews',
    });
  }
  return out;
}

/** The health glance — same dimensions + `ok|warn|bad` severity as the real Health projection (so a
 *  dimension reads identically on Today and Health). Severity per DL-2's HealthProjection: a dangling
 *  (dead) link is `bad` (oxide); orphans/thin are `warn` (brass); a zero count is `ok` (settled). */
function buildHealth(inputs: TodayInputs): TodayHealthRow[] {
  const dangling = safeCount(inputs.health.dangling);
  const orphans = safeCount(inputs.health.orphans);
  const thin = safeCount(inputs.health.thin);
  return [
    { key: 'dangling', label: 'Dangling links', sub: 'Links to nothing', value: String(dangling), status: dangling === 0 ? 'ok' : 'bad' },
    { key: 'orphans', label: 'Orphans', sub: 'Unlinked sources', value: String(orphans), status: orphans === 0 ? 'ok' : 'warn' },
    { key: 'thin', label: 'Thin stubs', sub: 'Entities with <2 claims', value: String(thin), status: thin === 0 ? 'ok' : 'warn' },
  ];
}

/** Compact relative age: "6m" / "2h" / "3d" / "now". */
export function compactAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
