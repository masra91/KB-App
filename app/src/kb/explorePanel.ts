// Explore panel — pure neighborhood-assembly over the read-only recall surface (SPEC-0039 EXPLORE).
//
// EXPLORE v1 is the **entity-neighborhood** view: a focused entity centered, its directly-linked
// (1-hop) entities around it, read from the evergreen `entities/` graph. This module is the pure,
// node-tested logic (EXPLORE-1 read-only by construction — it only calls the read-only RecallTools);
// the IPC handler (main) and the DOM view (renderer) are thin shells over it.
//
// Edges: Connect promotes entity↔entity `[[wikilinks]]` (CONNECT-12). The rendered wikilink carries
// the target + display name but NOT a per-link predicate/confidence in v1 (predicates are "usually
// absent", DATA-8 link-confidence isn't persisted in the link) — so a v1 edge surfaces the NEIGHBOR
// NODE's kind + confidence (which ARE on the node), and an out/in/both direction. Typed predicates +
// per-edge confidence are a documented v2 enhancement (EXPLORE-5 is a `should`).
import type { RecallTools, EntityHit, ClaimHit } from './recall';
import { deriveSourceTitle } from './sourceDoc';

/** A lightweight entity reference for the search-to-focus picker (EXPLORE-6). */
export interface ExploreEntityRef {
  rel: string; // repo-relative node path (stable focus key, collision-safe)
  id: string;
  name: string;
  kind: string;
  confidence: number;
}

/** A 1-hop neighbor of the focused entity, with the edge direction. */
export interface ExploreNeighbor extends ExploreEntityRef {
  direction: 'out' | 'in' | 'both'; // outgoing link, incoming backlink, or both
}

/**
 * A claim's cited source, surfaced as a **clickable wiki-citation** (SPEC-0046 WS-A). `ref` is the
 * vault-relative `source.md` path the renderer hands to `openSourceRef` (working-zone-aware open —
 * REVIEW-17); `title` is the **human** source title (`deriveSourceTitle`) — NEVER a ULID (PRIN-24).
 */
export interface ExploreCitation {
  ref: string; // e.g. `sources/<shard>/<id>/source.md` — handed to kbApi.openSourceRef
  title: string; // human source title, never a raw id (PRIN-24)
}

/** A center entity's claim, rendered read-only (the "leads back to reading" affordance, EXPLORE-4). */
export interface ExploreClaim {
  statement: string;
  status: string; // fact | interpretation | hypothesis | …
  confidence: number;
  citations: ExploreCitation[]; // the claim's cited sources, clickable (WS-A) — possibly empty
}

/** The focused entity + its bounded 1-hop neighborhood (EXPLORE-2/3/8). */
export interface ExploreNeighborhood {
  found: boolean; // false → the requested focus didn't resolve (or the graph is empty)
  center?: ExploreEntityRef & { tags: string[] };
  claims: ExploreClaim[]; // the center's claims (read-only), up to a small cap
  neighbors: ExploreNeighbor[]; // bounded to topK, ranked by confidence
  shown: number; // neighbors returned (== neighbors.length)
  total: number; // total distinct 1-hop neighbors (for the "+N more" overflow, EXPLORE-8)
}

/** Default neighborhood bound (EXPLORE-8): focus + top-K neighbors, "+N more" beyond. */
export const DEFAULT_TOP_K = 12;
const CENTER_CLAIM_CAP = 8;
const ENTITY_SCAN_LIMIT = 2000;

/** Parse a wikilink target (`entities/kind/slug.md|Display Name` or a bare name) → its path/name part. */
function linkTargetPath(to: string): string {
  const bar = to.indexOf('|');
  return (bar === -1 ? to : to.slice(0, bar)).trim();
}

const byConfidence = (a: ExploreEntityRef, b: ExploreEntityRef): number =>
  b.confidence - a.confidence || a.name.localeCompare(b.name);

/** All entities as lightweight refs, name-sorted — the search-to-focus source (EXPLORE-6). */
export async function listExploreEntities(tools: RecallTools): Promise<ExploreEntityRef[]> {
  const all = await tools.entityLookup({ query: '', limit: ENTITY_SCAN_LIMIT });
  return all
    .map((e) => ({ rel: e.rel, id: e.id, name: e.name, kind: e.kind, confidence: e.confidence }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A source dir → its `source.md` ref (what `openSourceRef` resolves). Tolerates a trailing slash. */
function sourceRefOf(dir: string): string {
  return `${dir.replace(/\/+$/, '')}/source.md`;
}

/**
 * SPEC-0046 WS-A — attach each claim's cited sources as clickable, **titled** citations. A claim's
 * `derivedFrom` carries its source dir(s); we resolve each to a human title (`deriveSourceTitle`,
 * never a ULID — PRIN-24) + the `source.md` ref the renderer opens working-zone-aware. Titles are
 * read once per distinct source (deduped cache) and bounded by the small claim cap. ENG-16: a source
 * whose `source.md` can't be read still surfaces by a neutral generic title — never crashes the load.
 */
async function withCitations(tools: RecallTools, claimsRaw: readonly ClaimHit[]): Promise<ExploreClaim[]> {
  // Distinct source dirs across all claims → resolve each title once (bounded fan-out).
  const dirs = new Set<string>();
  for (const c of claimsRaw) for (const d of c.derivedFrom ?? []) if (typeof d === 'string' && d.trim()) dirs.add(d);
  const titleByDir = new Map<string, string>();
  await Promise.all(
    [...dirs].map(async (dir) => {
      let md: string | null = null;
      try {
        md = await tools.readSource({ dir });
      } catch {
        md = null; // a read failure degrades to the neutral generic title, never throws (ENG-16)
      }
      titleByDir.set(dir, deriveSourceTitle(md ?? ''));
    }),
  );
  return claimsRaw.map((c) => {
    const seen = new Set<string>();
    const citations: ExploreCitation[] = [];
    for (const dir of c.derivedFrom ?? []) {
      if (typeof dir !== 'string' || !dir.trim() || seen.has(dir)) continue;
      seen.add(dir);
      citations.push({ ref: sourceRefOf(dir), title: titleByDir.get(dir) ?? deriveSourceTitle('') });
    }
    return { statement: c.statement, status: c.status, confidence: c.confidence, citations };
  });
}

/**
 * Assemble the focused entity's 1-hop neighborhood. `focus` may be a node rel-path, an id, or a name
 * (case-insensitive); when absent/unresolved it falls back to the highest-confidence entity so Explore
 * always lands on *something*. Bounded to `topK` neighbors with a `total` for the overflow affordance.
 * Returns `found: false` only when the graph has no entities at all.
 */
export async function buildNeighborhood(tools: RecallTools, focus?: string, topK = DEFAULT_TOP_K): Promise<ExploreNeighborhood> {
  const all = await tools.entityLookup({ query: '', limit: ENTITY_SCAN_LIMIT });
  if (all.length === 0) return { found: false, claims: [], neighbors: [], shown: 0, total: 0 };

  // Resolve the center: exact rel/id/name match → name substring → highest-confidence fallback.
  const needle = focus?.trim().toLowerCase() ?? '';
  let center: EntityHit | undefined;
  if (needle) {
    center =
      all.find((e) => e.rel === focus || e.id === focus || e.name.toLowerCase() === needle) ??
      all.find((e) => e.name.toLowerCase().includes(needle));
  }
  if (!center) center = [...all].sort(byConfidence)[0];

  const byRel = new Map(all.map((e) => [e.rel, e] as const));
  const byName = new Map(all.map((e) => [e.name.toLowerCase(), e] as const));

  // 1-hop edges from the center: outgoing wikilinks + incoming backlinks; entity neighbors only
  // (incoming `from` can be a claim file — those aren't graph nodes, VAULT-2 — so we keep only ones
  // that resolve to a known entity). Direction folds to 'both' when a pair links mutually.
  const { outgoing, incoming } = await tools.linkTraversal({ entity: center.rel });
  const dir = new Map<string, 'out' | 'in' | 'both'>();
  const mark = (rel: string, d: 'out' | 'in'): void => {
    if (rel === center!.rel) return; // never list the focus as its own neighbor
    const cur = dir.get(rel);
    dir.set(rel, !cur ? d : cur === d ? d : 'both');
  };
  for (const o of outgoing) {
    const tp = linkTargetPath(o.to);
    const hit = byRel.get(tp) ?? byName.get(tp.toLowerCase());
    if (hit) mark(hit.rel, 'out');
  }
  for (const i of incoming) {
    const hit = byRel.get(i.from);
    if (hit) mark(hit.rel, 'in');
  }

  const neighbors: ExploreNeighbor[] = [];
  for (const [rel, d] of dir) {
    const e = byRel.get(rel);
    if (e) neighbors.push({ rel, id: e.id, name: e.name, kind: e.kind, confidence: e.confidence, direction: d });
  }
  neighbors.sort(byConfidence);

  const claimsRaw = await tools.claimsForEntity({ entity: center.rel, limit: CENTER_CLAIM_CAP });
  const claims = await withCitations(tools, claimsRaw);

  const shown = neighbors.slice(0, topK);
  return {
    found: true,
    center: { rel: center.rel, id: center.id, name: center.name, kind: center.kind, confidence: center.confidence, tags: center.tags },
    claims,
    neighbors: shown,
    shown: shown.length,
    total: neighbors.length,
  };
}
