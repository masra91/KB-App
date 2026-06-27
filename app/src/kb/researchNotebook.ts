// The researcher's "field notebook" (SPEC-0028 RESEARCH-21, warm-start Slice 4a) — a persistent,
// per-researcher local digest under `.kb/research/<researcher-id>/notebook.json`, DERIVED from the
// researcher's OWN audit lineage (RESEARCH-6). It records what the researcher has returned (findings +
// their citations), the subjects/areas it has already drilled (with last-touched timestamps so a stale
// area re-opens), and the sources/domains it has already harvested. It is a DERIVED INDEX, not a second
// source of truth — the audit is canonical; the notebook is the cheap working set, rebuilt from it — and
// BOUNDED + self-healing (rolling caps, stale ages out; mirrors `seen.json`/`passes.json`). The orient
// phase (RESEARCH-22) reads it at the start of a pass to chase the GAP + a result-level DEDUP SET, so a
// run expands the frontier instead of re-fetching the same first-page hits.
//
// This piece reintroduces NO exfiltration surface — a researcher reading its OWN prior outputs/citations
// — so it ships independent of the D6 egress mapping (D8): no sensitivity gate here.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readEvents } from './activityIndex';
import { isEnrichmentGap } from './enrichGap';
import { isSafeResearcherId, normalizeTerm } from './researchers';

/** A subject/area the researcher has already drilled (re-opens when stale, see {@link isAreaStale}). */
export interface NotebookArea {
  key: string;
  lastRunTs: number;
  returned: 'finding' | 'no-finding' | 'failed';
  citations: number;
  /**
   * The orient ANGLES already drilled for this area within the staleness window (RESEARCH-QUALITY) — the
   * decorated steers (e.g. `re Ada Lovelace: education`) the prior passes targeted. Orient passes these to
   * `chooseAngle` as the exclusion set so a re-run on the SAME entity ROTATES to a different missing facet
   * (different query → different results) instead of re-issuing the identical gap query every pass. Only
   * non-stale angles are kept, so a facet drilled long ago legitimately re-opens. Absent on legacy notebooks.
   */
  targetedFacets?: string[];
}
/** A source the researcher has already fetched+cited → result-level dedup (don't re-find page 1). */
export interface NotebookSource {
  host: string;
  url: string;
  ts: number;
}
/** An expand-next lead: a term a prior finding raised but did NOT cover (maintained incrementally). */
export interface NotebookFrontier {
  term: string;
  fromSourceId: string;
  ts: number;
}
export interface FieldNotebook {
  researcherId: string;
  areas: NotebookArea[];
  harvested: NotebookSource[];
  frontier: NotebookFrontier[];
}

// Rolling caps (bounded — keep the newest N, drop the rest) + a staleness window (a harvested source older
// than this can legitimately be re-found, and an area older than this re-opens for re-research). Tuned
// modest: the notebook is a cheap working set, not an archive (the audit is canonical).
export const NOTEBOOK_AREAS_CAP = 100;
export const NOTEBOOK_HARVESTED_CAP = 500;
export const NOTEBOOK_FRONTIER_CAP = 100;
export const NOTEBOOK_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Absolute path to a researcher's field notebook. `id` is slug-guarded (it composes into the path). */
export function notebookPath(root: string, researcherId: string): string {
  return path.join(path.resolve(root), '.kb', 'research', researcherId, 'notebook.json');
}

/** The stable area key for a subject (mirrors dedupKeyFor): normalized `what` + the entity it's about. */
export function areaKey(what: string, entityId?: string): string {
  const w = normalizeTerm(what);
  return entityId ? `${w}::${entityId}` : w;
}

/** Is this area stale (last drilled longer ago than the staleness window)? Stale → orient re-opens it. */
export function isAreaStale(area: Pick<NotebookArea, 'lastRunTs'>, nowMs: number): boolean {
  return nowMs - area.lastRunTs >= NOTEBOOK_STALE_MS;
}

const empty = (researcherId: string): FieldNotebook => ({ researcherId, areas: [], harvested: [], frontier: [] });

/** Read the persisted notebook (graceful empty on missing/malformed — self-healing, never throws). */
export async function readNotebook(root: string, researcherId: string): Promise<FieldNotebook> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(notebookPath(root, researcherId), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Partial<FieldNotebook>;
      return {
        researcherId,
        areas: Array.isArray(o.areas) ? o.areas.filter(isArea) : [],
        harvested: Array.isArray(o.harvested) ? o.harvested.filter(isSource) : [],
        frontier: Array.isArray(o.frontier) ? o.frontier.filter(isFrontier) : [],
      };
    }
  } catch {
    /* missing/corrupt → empty notebook */
  }
  return empty(researcherId);
}

/** Persist the notebook (id slug-guarded before any path is touched — #29). */
export async function writeNotebook(root: string, researcherId: string, nb: FieldNotebook): Promise<void> {
  if (!isSafeResearcherId(researcherId)) throw new Error(`refusing to write notebook for unsafe researcher id: ${JSON.stringify(researcherId)}`);
  const p = notebookPath(root, researcherId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(nb, null, 2) + '\n', 'utf8');
}

/** Bound a notebook: keep the newest entries up to each cap, and prune harvested sources older than the
 *  staleness window (a year-old source can be legitimately re-found). Pure + idempotent (self-healing). */
export function boundNotebook(nb: FieldNotebook, nowMs: number): FieldNotebook {
  const newestFirst = <T extends { ts?: number; lastRunTs?: number }>(a: T, b: T): number => (b.ts ?? b.lastRunTs ?? 0) - (a.ts ?? a.lastRunTs ?? 0);
  return {
    researcherId: nb.researcherId,
    areas: [...nb.areas].sort((a, b) => b.lastRunTs - a.lastRunTs).slice(0, NOTEBOOK_AREAS_CAP),
    harvested: [...nb.harvested].filter((s) => nowMs - s.ts < NOTEBOOK_STALE_MS).sort(newestFirst).slice(0, NOTEBOOK_HARVESTED_CAP),
    frontier: [...nb.frontier].sort(newestFirst).slice(0, NOTEBOOK_FRONTIER_CAP),
  };
}

/**
 * Rebuild a researcher's notebook from its OWN audit lineage (RESEARCH-6) — the canonical source. Reads
 * the researcher's `researched`/`no-finding`/`research-failed` events, folds them into areas (by subject
 * key, newest outcome + citation count) + harvested sources (cited URLs → host/url, newest ts), then
 * bounds. Returns a fresh, bounded notebook — the digest is always reconstructable from the audit.
 *
 * RESEARCH-QUALITY — the frontier is now DERIVED from the audit (it was dead code: `NotebookFrontier`
 * existed but nothing ever populated it, so orient saw no fresh leads and re-issued the same angle every
 * run). Each pass records the GAP it ran against + the ANGLE it drilled on its audit event; here we fold
 * those across the lineage into:
 *   - `area.targetedFacets` — the angles already drilled for a subject (within the staleness window), so
 *     orient can EXCLUDE them and rotate to a different missing facet on the next run; and
 *   - `frontier` — the gap's MISSING facets that NO pass has targeted yet (the uncovered leads), so even a
 *     re-dispatch whose request lost its gap still has gap-grounded angles to pursue.
 */
export async function deriveNotebook(root: string, researcherId: string, nowMs: number): Promise<FieldNotebook> {
  const events = await readEvents(root, { actors: ['researcher'], subjectId: researcherId }); // newest-first
  const areasByKey = new Map<string, NotebookArea>();
  const sourcesByUrl = new Map<string, NotebookSource>();
  const targetedByKey = new Map<string, string[]>(); // area key → angles drilled (non-stale)
  const missingByKey = new Map<string, Map<string, { ts: number; fromSourceId: string }>>(); // area key → facet → newest lead
  for (const e of events) {
    const ts = Date.parse(e.ts) || 0;
    const what = typeof e.payload.what === 'string' ? e.payload.what : '';
    if (!what) continue;
    const key = areaKey(what, e.subjects.entityId);
    const citations = Array.isArray(e.payload.citations) ? e.payload.citations.length : 0;
    const returned: NotebookArea['returned'] = e.eventType === 'researched' ? 'finding' : e.eventType === 'research-failed' ? 'failed' : 'no-finding';
    // events are newest-first → the FIRST time we see a key is its most recent outcome.
    if (!areasByKey.has(key)) areasByKey.set(key, { key, lastRunTs: ts, returned, citations });
    if (Array.isArray(e.payload.citations)) {
      for (const c of e.payload.citations) {
        const url = typeof c === 'string' ? c : '';
        if (!url) continue;
        const host = hostOf(url);
        const existing = sourcesByUrl.get(url);
        if (!existing || ts > existing.ts) sourcesByUrl.set(url, { host, url, ts });
      }
    }
    // The angle drilled this pass — kept only when non-stale so an old facet re-opens for re-research.
    const angle = typeof e.payload.angle === 'string' ? e.payload.angle.trim() : '';
    if (angle && nowMs - ts < NOTEBOOK_STALE_MS) {
      const arr = targetedByKey.get(key) ?? [];
      arr.push(angle);
      targetedByKey.set(key, arr);
    }
    // The gap the pass ran against → its missing facets are candidate frontier leads (newest ts wins).
    if (isEnrichmentGap(e.payload.gap)) {
      const fm = missingByKey.get(key) ?? new Map<string, { ts: number; fromSourceId: string }>();
      const fromSourceId = e.subjects.sourceId ?? e.subjects.requestId ?? '';
      for (const facet of e.payload.gap.missing) {
        if (typeof facet !== 'string' || facet.trim().length === 0) continue;
        const prev = fm.get(facet);
        if (!prev || ts > prev.ts) fm.set(facet, { ts, fromSourceId });
      }
      missingByKey.set(key, fm);
    }
  }
  // Attach the per-area exclusion set (dedup the angle strings, keep insertion order).
  for (const [key, angles] of targetedByKey) {
    const area = areasByKey.get(key);
    if (area) area.targetedFacets = [...new Set(angles)];
  }
  // Frontier: a gap facet is a live lead only if NO recorded angle for its area already targeted it.
  const frontier: NotebookFrontier[] = [];
  for (const [key, facets] of missingByKey) {
    const drilled = (targetedByKey.get(key) ?? []).map((a) => a.toLowerCase());
    for (const [facet, info] of facets) {
      if (drilled.some((a) => a.includes(facet.toLowerCase()))) continue; // already covered by a prior angle
      frontier.push({ term: facet, fromSourceId: info.fromSourceId, ts: info.ts });
    }
  }
  const derived: FieldNotebook = {
    researcherId,
    areas: [...areasByKey.values()],
    harvested: [...sourcesByUrl.values()],
    frontier,
  };
  return boundNotebook(derived, nowMs);
}

/** The result-level dedup set (RESEARCH-21): URLs the researcher has already harvested → skip re-finding. */
export function knownSourceUrls(nb: FieldNotebook): Set<string> {
  return new Set(nb.harvested.map((s) => s.url));
}
/** The hosts already harvested — a coarser dedup signal (steer away from the same domains' page 1). */
export function knownHosts(nb: FieldNotebook): Set<string> {
  return new Set(nb.harvested.map((s) => s.host));
}

/** Best-effort host extraction; a non-URL citation falls back to the raw string (still dedup-able). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isArea(v: unknown): v is NotebookArea {
  const o = v as NotebookArea;
  return !!o && typeof o.key === 'string' && typeof o.lastRunTs === 'number';
}
function isSource(v: unknown): v is NotebookSource {
  const o = v as NotebookSource;
  return !!o && typeof o.url === 'string' && typeof o.ts === 'number';
}
function isFrontier(v: unknown): v is NotebookFrontier {
  const o = v as NotebookFrontier;
  return !!o && typeof o.term === 'string' && typeof o.ts === 'number';
}
