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
import { isSafeResearcherId, normalizeTerm } from './researchers';

/** A subject/area the researcher has already drilled (re-opens when stale, see {@link isAreaStale}). */
export interface NotebookArea {
  key: string;
  lastRunTs: number;
  returned: 'finding' | 'no-finding' | 'failed';
  citations: number;
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
 * bounds. `frontier` is carried from `prior` (it's maintained incrementally by the run phase, not derived
 * from audit). Returns a fresh, bounded notebook — the digest is always reconstructable from the audit.
 */
export async function deriveNotebook(root: string, researcherId: string, nowMs: number, prior?: FieldNotebook): Promise<FieldNotebook> {
  const events = await readEvents(root, { actors: ['researcher'], subjectId: researcherId }); // newest-first
  const areasByKey = new Map<string, NotebookArea>();
  const sourcesByUrl = new Map<string, NotebookSource>();
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
  }
  const derived: FieldNotebook = {
    researcherId,
    areas: [...areasByKey.values()],
    harvested: [...sourcesByUrl.values()],
    frontier: prior?.frontier ?? [],
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
