// Health PROJECTION (SPEC-0058 STATE-3/13) — the surface-local read model the Health view consumes, shaped
// EXACTLY to KB-Design-Lead-2's render contract (the prototype "health glance"). The view draws everything
// it shows from ONE projection read (STATE-13, design-from-the-screens-inward); the severity policy is baked
// HERE, not in the view (a discrete `severity` enum the view maps to a tile hue — never a colour in the data).
//
// This is a PURE transform over the structural-lint `HealthReport` (healthPanel) — it carries no I/O, so it
// is unit-testable in isolation and reusable regardless of where the report comes from. Today the IPC builds
// the report from the read-only RecallTools (the existing O(N) scan); when DEV-5's projection CORE (the
// maintained graph projection, STATE-2) is posted, the report is derived from THAT instead — this transform
// and the whole view contract are unchanged (the read-layer swaps underneath). Holding that seam avoids
// colliding with the shared graph-projection work.
// Import the key from the PURE module (NOT healthPanel) so this renderer-reachable transform never pulls
// healthPanel's node-side deps (directives → node:fs) into the browser bundle (#500). healthPanel types
// are `import type` (erased), so they carry no runtime edge.
import { healthFindingKey, type HealthFindingClass } from './healthFindingKey';
import type { HealthReport, HealthFinding, DanglingLink } from './healthPanel';

/** Whether the maintained projection is live, still indexing, or genuinely unavailable (STATE-9). `warming`
 *  renders a calm "still preparing…" (never the scary "app busy"); `unavailable` is the honest error face. */
export type HealthStatus = 'ready' | 'warming' | 'unavailable';

/** A discrete severity the VIEW maps to a tile hue (#184: hue rides the tile + count, the label stays ink).
 *  `ok` = clean, `warn` = attention (orphans/thin), `bad` = broken structure (dead links). Never a colour. */
export type HealthSeverity = 'ok' | 'warn' | 'bad';

/** The three structural-lint dimensions the glance renders, in display order. */
export type HealthDimensionKey = 'dangling' | 'orphans' | 'thin';

/** A finding within a dimension — the existing union, unchanged: entity findings (orphans/thin) carry the
 *  node identity; dead-link findings carry the source + unresolved target. The view discriminates + degrades
 *  a malformed one to "(untitled)" per-item (ENG-15/16) — findings are PASSED THROUGH, never dropped here. */
export type HealthDimensionFinding = HealthFinding | DanglingLink;

/** A projected finding carries its content-stable `key` (SPEC-0060 VUX-16) so the Health view can DISMISS
 *  it without re-deriving the key — re-deriving in the renderer would risk drifting from the backend's
 *  `blockKey` normalize, making a dismiss silently no-op. The view passes this `key` straight to
 *  `kb:dismissHealthFinding`. ADDITIVE over the union (every render field is preserved). */
export type ProjectedHealthFinding = HealthDimensionFinding & { key: string };

/** One row of the health glance: a labelled dimension with its severity tile, count, and (capped) findings. */
export interface HealthDimension {
  key: HealthDimensionKey;
  /** Human label — "Dead links" | "Orphans" | "Thin pages". */
  label: string;
  /** One-line scholarly description (the `.ht` span under the title). */
  desc: string;
  /** Discrete severity → the view's tile hue (#184). `ok` when count 0, else the dimension's attention level. */
  severity: HealthSeverity;
  /** The FULL count (the `findings` list may be capped by healthPanel's FINDING_CAP). */
  count: number;
  /** The (capped) findings to render, each carrying its dismiss `key`; `[]` when count is 0. Malformed
   *  entries pass through (ENG-15/16). */
  findings: ProjectedHealthFinding[];
}

/** The maintained Health projection — the single shape the Health view renders (DL-2's render contract). */
export interface HealthProjection {
  status: HealthStatus;
  /** Entities scanned ("scanned N entities"). */
  scanned: number;
  /** ISO timestamp the projection was built (rendered as a mono "as of …" stamp). */
  generatedAt: string;
  /** `ok` when there are zero issues, else `attention` — drives the calm-vs-attention summary. */
  overall: 'ok' | 'attention';
  /** Total issues across all dimensions (0 → `overall: ok`). */
  totalIssues: number;
  dimensions: HealthDimension[];
}

/** The dimension catalog (order + label + description). Descriptions read as scholarly one-liners — they are
 *  user-facing copy, so they live with the projection shape (the view renders them verbatim). */
const DIMENSION_META: { key: HealthDimensionKey; label: string; desc: string; bad: boolean }[] = [
  { key: 'dangling', label: 'Dead links', desc: 'A link points to a node that no longer exists — often a merged or renamed entity.', bad: true },
  { key: 'orphans', label: 'Orphans', desc: 'An entity with no links in or out — disconnected from the rest of the graph.', bad: false },
  { key: 'thin', label: 'Thin pages', desc: 'A sparse / stub entity with very little content — a candidate to expand from its sources.', bad: false },
];

/** A dimension's severity (the baked policy, DL-2): clean → `ok`; a dead-links hit is `bad` (broken graph),
 *  an orphans/thin hit is `warn` (attention). Pure. */
export function dimensionSeverity(key: HealthDimensionKey, count: number): HealthSeverity {
  if (count <= 0) return 'ok';
  return DIMENSION_META.find((d) => d.key === key)?.bad ? 'bad' : 'warn';
}

/**
 * Transform a structural-lint {@link HealthReport} into the {@link HealthProjection} the view renders
 * (STATE-13). Bakes the severity policy + dimension copy, computes `overall`/`totalIssues`, and passes every
 * finding through (no dropping — the view degrades a malformed one per-item, ENG-15/16). `generatedAt` is the
 * injected build stamp (the IPC supplies `now`; tests supply a fixed ISO). Always `status: 'ready'` — the
 * `warming`/`unavailable` envelopes are produced by {@link warmingHealthProjection}/{@link unavailableHealthProjection}.
 */
export function toHealthProjection(report: HealthReport, generatedAt: string): HealthProjection {
  // The dimension key → the finding CLASS healthFindingKey expects (singular 'orphan', not 'orphans').
  const CLASS_FOR: Record<HealthDimensionKey, HealthFindingClass> = { dangling: 'dangling', orphans: 'orphan', thin: 'thin' };
  const findingsFor = (key: HealthDimensionKey): ProjectedHealthFinding[] => {
    const raw: HealthDimensionFinding[] = key === 'dangling' ? report.dangling : key === 'orphans' ? report.orphans : report.thin;
    const cls = CLASS_FOR[key];
    return raw.map((f) => ({ ...f, key: healthFindingKey(cls, f) }));
  };
  const dimensions: HealthDimension[] = DIMENSION_META.map((m) => {
    const count = report.counts[m.key];
    return { key: m.key, label: m.label, desc: m.desc, severity: dimensionSeverity(m.key, count), count, findings: findingsFor(m.key) };
  });
  const totalIssues = report.counts.dangling + report.counts.orphans + report.counts.thin;
  return {
    status: 'ready',
    scanned: report.scanned,
    generatedAt,
    overall: totalIssues === 0 ? 'ok' : 'attention',
    totalIssues,
    dimensions,
  };
}

/** A calm WARMING envelope (STATE-9) — the maintained projection isn't built yet; the view shows "still
 *  preparing…", never the scary error. (Used once DEV-5's maintained projection can report `warming`.) */
export function warmingHealthProjection(): HealthProjection {
  return { status: 'warming', scanned: 0, generatedAt: '', overall: 'ok', totalIssues: 0, dimensions: [] };
}

/** A genuine UNAVAILABLE envelope (STATE-10) — a real scan error; the view shows "couldn't scan — recheck". */
export function unavailableHealthProjection(): HealthProjection {
  return { status: 'unavailable', scanned: 0, generatedAt: '', overall: 'ok', totalIssues: 0, dimensions: [] };
}

/** Discriminate a dead-link finding from an entity finding (the view picks the right row renderer). */
export function isDanglingFinding(f: HealthDimensionFinding): f is DanglingLink {
  return typeof (f as DanglingLink).target === 'string';
}
