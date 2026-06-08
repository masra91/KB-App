// "The Line" — pure presentation model (SPEC-0032 / DESIGN-VIZ "The Line"). DOM-free data→view-data
// derivations the renderer (statusView.ts) turns into HTML; kept here so the funnel math, stepper
// fill, dwell, and virtualization are unit-tested without a DOM (TEST-5, and the §5 motion/§2 funnel
// logic are the part most worth pinning). Reads the SPEC-0030 `PipelineStatusView` (+ the three §9
// data fields DEV-3 landed: `inFlight` #175, `conversion` #169, `STAGE_ORDER` #168) — it never
// mutates and never imports electron/DOM.
import { STAGE_ORDER, stageIndex } from '../../kb/pipelineStages';
import { stageDisplayName } from '../stageLabels';
// Overall-state glyph vocabulary now lives in the neutral kb layer so the tray (main) shares one
// source with The Line (QCAP-14); re-exported here so existing importers are unchanged.
export { OVERALL_GLYPH } from '../../kb/pipelineStatusLabels';
import type { StageId } from '../../kb/pipelineStages';
import type {
  PipelineStatusView,
  StageStatus,
  StageState,
  ConversionCounts,
  InFlightItem,
} from '../../kb/pipelineStatusView';

// ── State vocabulary (§3/§6) — state is NEVER color alone: each carries a distinct glyph + hue + a
// fill class, so it survives color-blindness and grayscale. The four StageStatus states + the two
// stepper-cell roles (done/pending) complete the `◐ ▣ ○ ✓ ✕` set from the design. ──────────────────

/** Glyph per stage liveness state (§6 station node). Distinct shapes so the state reads without color. */
export const STATION_GLYPH: Record<StageState, string> = {
  idle: '○', // at rest
  running: '▣', // the one active station — embers + breathes
  blocked: '◐', // queued, waiting on the lock / between sweeps
  error: '✕', // failing
};

/** The hue utility class (from design-system.css) per state — fills/glyphs/large elements only (§3). */
export const STATION_STATE_CLASS: Record<StageState, string> = {
  idle: 'viz-state-idle',
  running: 'viz-state-running',
  blocked: 'viz-state-blocked',
  error: 'viz-state-error',
};

/** One station on the spine — its own liveness merged with its funnel gauge-rail (§2/§6). */
export interface StationModel {
  stage: StageId;
  /** Human label (display-only — `stageLabels`). */
  name: string;
  state: StageState;
  glyph: string;
  stateClass: string;
  queueDepth: number;
  /** The real backlog here is STUCK (§6 role 3 / VIZ-10 / OBS-11) → the renderer tints the queue brass
   *  (needs-you). Stuck-coupled, NOT depth: a deep-but-*draining* queue is healthy work (the Principal
   *  routinely has hundreds in flight), so brass fires only when this stage is blocked/errored or the
   *  whole pipeline is stalled AND there's a backlog — never on depth alone (the cry-wolf guard). */
  queueConcerning: boolean;
  setAside: number;
  currentItem?: string;
  /** This station's gauge-rail (volume bar + directional conversion caption). */
  rail: FunnelRail;
  /** The slowest station tints its rail oxide-ward + shows its latency (§6, VIZ-4). */
  slowest: boolean;
  /** Per-stage latency caption for the slowest station (e.g. "1500ms avg"), else ''. */
  latency: string;
}

/** A gauge-rail: a volume bar (% of the funnel's peak) + the directional conversion caption to the
 *  next station (§2). The terminal PROMOTE rail carries a completion *ratio*, not a delta.
 *  VIZ-10 (funnel-caption legibility): the rail carries the two RAIL-lane numbers — *volume*
 *  (reached-here, with its bucket noun) and the *conversion projection* (to-next) — each with a
 *  role-declaring signifier + a decode-on-hover title so a projection can never read as a backlog. */
export interface FunnelRail {
  stage: StageId;
  count: number;
  /** Bar height as a % of the funnel's peak bucket (so a fan-out reads as the stream *widening*). */
  barPct: number;
  /** Volume bucket noun (§6 role 1 / VIZ-10) — the count self-describes as `<count> <noun>`
   *  (`399 entities`). Mirrors `bucketFor`'s stage→bucket mapping. */
  noun: string;
  /** Decode-on-hover for the volume count (VIZ-10 `title=`): e.g. `399 entities reached Linking`. */
  countTitle: string;
  /** The role-declaring conversion-projection caption to the NEXT stage (§6 role 2 / VIZ-10):
   *  `→ −23 deduped`, `→ +15 ×3.1 fan-out`, or the terminal `5/10 · 50% complete`; '' when none.
   *  The leading `→` ties it to the next station so it reads *flows-to-next*, never *waiting-here*.
   *  Small text → renders in ink/ink-muted (§3). */
  caption: string;
  /** What kind of caption (drives nothing colour-wise on small text; for tests + aria). */
  captionKind: 'reduction' | 'fanout' | 'ratio' | 'none';
  /** Decode-on-hover for the projection caption (VIZ-10 `title=`): e.g.
   *  `projected fan-out ×3.1 into Claim extraction`; '' when there's no caption. */
  captionTitle: string;
}

/** The volume bucket noun a station's count carries so a bare number self-describes (§6 role 1 /
 *  VIZ-10): `399 entities`. Mirrors `bucketFor`'s stage→bucket mapping (capture/archive→captured). */
export const BUCKET_NOUN: Record<StageId, string> = {
  capture: 'captured',
  archive: 'captured',
  decompose: 'candidates',
  connect: 'entities',
  claims: 'claims',
  promote: 'promoted',
};

// ── Funnel (§2 funnel unit logic; VIZ-3) ──────────────────────────────────────────────────────────
//
// The conversion counts are 5 buckets (captured → candidates → entities → claims → promoted); the
// spine is 6 stations. The mapping (documented so the two can't silently drift):
//   capture, archive → captured   (sources in; archive is a whole-source pass-through, count steady)
//   decompose        → candidates (decompose extracts candidate entities — a fan-out from sources)
//   connect          → entities   (connect dedups candidates into canonical entities — a reduction)
//   claims           → claims     (claims extraction fans out per entity)
//   promote          → promoted   (sources landed on `main` — the completion endpoint)
// `captured` and `promoted` are the SAME unit (sources) → their ratio is the completion rate, shown
// on PROMOTE. The mid buckets are intermediate transformation volumes → directional deltas. The
// claims→promote hop crosses units (claims-volume → sources-promoted), so claims shows NO delta and
// PROMOTE shows the ratio instead (§2, resolving #169).

/** The conversion bucket a station reads its volume from (see the table above). */
export function bucketFor(stage: StageId, c: ConversionCounts): number {
  switch (stage) {
    case 'capture':
    case 'archive':
      return c.captured;
    case 'decompose':
      return c.candidates;
    case 'connect':
      return c.entities;
    case 'claims':
      return c.claims;
    case 'promote':
      return c.promoted;
  }
}

/** The directional conversion projection from `a` → `b` (§2 / §6 role 2 / VIZ-10). Each carries a
 *  role-declaring signifier word so it can never read as a backlog: a reduction (dedup) reads
 *  `−N deduped`; a fan-out reads `+N ×ratio fan-out` (or `+N fan-out` when the source bucket is 0 and
 *  the ratio is undefined); no change → empty. Uses the typographic minus/multiply so it reads as an
 *  engineered caption. `buildFunnel` prepends the leading `→` that ties it to the next station. */
export function directionalDelta(a: number, b: number): { text: string; kind: FunnelRail['captionKind'] } {
  const d = b - a;
  if (d === 0) return { text: '', kind: 'none' };
  if (d < 0) return { text: `−${a - b} deduped`, kind: 'reduction' };
  const ratio = a > 0 ? b / a : null;
  return { text: ratio !== null ? `+${d} ×${ratio.toFixed(1)} fan-out` : `+${d} fan-out`, kind: 'fanout' };
}

/** The terminal completion ratio `promoted/captured · P%` (§2). Guards the 0/0 cold-start → `0/0 · 0%`. */
export function completionRatio(promoted: number, captured: number): string {
  if (captured <= 0) return '0/0 · 0%';
  return `${promoted}/${captured} · ${Math.round((promoted / captured) * 100)}%`;
}

/** Build the six gauge-rails (VIZ-3). Each station's bar scales to the funnel's peak bucket so a
 *  fan-out (e.g. Connect→Claims) reads as widening, not overflow. Captions are delta-to-next, except
 *  CLAIMS (its next crosses units → none) and PROMOTE (the completion ratio). */
export function buildFunnel(c: ConversionCounts): FunnelRail[] {
  const counts = STAGE_ORDER.map((s) => bucketFor(s, c));
  const peak = Math.max(0, ...counts);
  return STAGE_ORDER.map((stage, i) => {
    const count = counts[i];
    const barPct = peak > 0 ? Math.round((count / peak) * 100) : 0;
    const noun = BUCKET_NOUN[stage];
    // VIZ-10 decode-on-hover: the volume count says exactly what it counts + where (role 1).
    const countTitle = `${count} ${noun} reached ${stageDisplayName(stage)}`;
    let caption = '';
    let captionKind: FunnelRail['captionKind'] = 'none';
    let captionTitle = '';
    if (stage === 'promote') {
      // Terminal: the completion ratio (not a delta) — a `complete` signifier, no `→` (no next stage).
      caption = `${completionRatio(c.promoted, c.captured)} complete`;
      captionKind = 'ratio';
      captionTitle = `${c.promoted} of ${c.captured} captured sources promoted to main`;
    } else if (stage === 'claims') {
      caption = ''; // claims→promote crosses units; PROMOTE shows the ratio
      captionKind = 'none';
    } else {
      const next = counts[i + 1];
      const d = directionalDelta(count, next);
      if (d.kind !== 'none') {
        // The leading `→` ties the projection to the next station (role 2) — flows-to-next, not waiting-here.
        caption = `→ ${d.text}`;
        captionKind = d.kind;
        const nextName = stageDisplayName(STAGE_ORDER[i + 1]);
        captionTitle =
          d.kind === 'fanout'
            ? `projected fan-out${count > 0 ? ` ×${(next / count).toFixed(1)}` : ''} into ${nextName}`
            : `projected reduction −${count - next} deduped into ${nextName}`;
      }
    }
    return { stage, count, barPct, noun, countTitle, caption, captionKind, captionTitle };
  });
}

// ── Stations (§6 station node, merging liveness + the gauge-rail) ─────────────────────────────────

/** The slowest pipeline stage by mean run duration (§6 / VIZ-4 — the spatial "where time goes"). The
 *  model exposes per-stage `avgMs` (not per-stage p95), so the slowest = the longest mean; null when
 *  no stage has timing yet. */
export function slowestStage(perf: PipelineStatusView['perf']): { stage: string; avgMs: number } | null {
  let worst: { stage: string; avgMs: number } | null = null;
  for (const s of perf.stages) {
    if (s.avgMs > 0 && (worst === null || s.avgMs > worst.avgMs)) worst = { stage: s.stage, avgMs: s.avgMs };
  }
  return worst;
}

/** Build the six station models from the view-model. Stations the view-model doesn't enumerate
 *  (capture / promote bracket the four drains) default to idle/empty — the spine always shows all six
 *  (VIZ-5: one structure under both lenses). Each station merges its liveness, its gauge-rail, and
 *  the slowest-station latency tint. */
export function buildStations(v: PipelineStatusView): StationModel[] {
  const byStage = new Map<string, StageStatus>(v.stages.map((s) => [s.stage, s]));
  const rails = buildFunnel(v.conversion);
  const slow = slowestStage(v.perf);
  return STAGE_ORDER.map((stage, i) => {
    const st = byStage.get(stage);
    const state: StageState = st?.state ?? 'idle';
    const isSlowest = slow !== null && slow.stage === stage;
    const queueDepth = st?.queueDepth ?? 0;
    return {
      stage,
      name: stageDisplayName(stage),
      state,
      glyph: STATION_GLYPH[state],
      stateClass: STATION_STATE_CLASS[state],
      queueDepth,
      // Stuck-coupled, not depth (VIZ-10 / OBS-11): a stuck stage (blocked/error) or an overall-stalled
      // pipeline WITH a backlog is the needs-you case; a deep draining queue stays calm.
      queueConcerning: queueDepth > 0 && (state === 'blocked' || state === 'error' || v.stalled),
      setAside: st?.setAside ?? 0,
      ...(st?.currentItem !== undefined ? { currentItem: st.currentItem } : {}),
      rail: rails[i],
      slowest: isSlowest,
      latency: isSlowest && slow ? `${slow.avgMs}ms avg` : '',
    };
  });
}

// ── Carriages (§2 in-flight; VIZ-2 the "pizza tracker" stepper) ───────────────────────────────────

/** One stepper cell's role, by position vs the carriage's current station (drives the fill: done =
 *  patina, current = ember/lit, pending = `·`). */
export type CellRole = 'done' | 'current' | 'pending';

/** The six stepper cells for an item at `stage` — `stageIndex` before its current = done, the current
 *  is lit, the rest pending (the carriage `[██████▣·····]`). */
export function stepperCells(stage: StageId): CellRole[] {
  const cur = stageIndex(stage);
  return STAGE_ORDER.map((_, i) => (i < cur ? 'done' : i === cur ? 'current' : 'pending'));
}

/** The carriage's current-station dwell caption ("12s on Copilot") from its `sinceTs` (§2). Only the
 *  active (draining) carriage carries `sinceTs`, so queued carriages get ''. NaN/absent → ''. */
export function dwellLabel(sinceTs: string | undefined, nowMs: number): string {
  if (!sinceTs) return '';
  const ms = Date.parse(sinceTs);
  if (!Number.isFinite(ms)) return '';
  const secs = Math.max(0, Math.round((nowMs - ms) / 1000));
  return `${secs}s on Copilot`;
}

/** Max carriages rendered before the rest collapse into a "+K more in flight" row (§5 VIZ-9 — keeps
 *  motion at 60fps with many items; the virtualization budget). */
export const MAX_CARRIAGES = 12;

/** One carriage as the renderer draws it (VIZ-2). */
export interface CarriageModel {
  itemId: string;
  name: string;
  stage: StageId;
  stageName: string;
  active: boolean;
  cells: CellRole[];
  dwell: string;
}

/** Split the in-flight roster into the visible carriages + an overflow count (VIZ-9 virtualization).
 *  Active (draining) carriages sort first so live work is always on screen even past the budget. */
export function splitCarriages(
  items: InFlightItem[],
  nowMs: number,
  max: number = MAX_CARRIAGES,
): { shown: CarriageModel[]; more: number } {
  const ordered = [...items].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  const shown = ordered.slice(0, max).map((it) => ({
    itemId: it.itemId,
    name: it.name || it.itemId,
    stage: it.stage,
    stageName: stageDisplayName(it.stage),
    active: Boolean(it.active),
    cells: stepperCells(it.stage),
    dwell: it.active ? dwellLabel(it.sinceTs, nowMs) : '',
  }));
  return { shown, more: Math.max(0, ordered.length - max) };
}
