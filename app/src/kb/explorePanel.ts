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
import type { RecallTools, EntityHit } from './recall';

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

/** A center entity's claim, rendered read-only (the "leads back to reading" affordance, EXPLORE-4). */
export interface ExploreClaim {
  statement: string;
  status: string; // fact | interpretation | hypothesis | …
  confidence: number;
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
  const claims = claimsRaw.map((c) => ({ statement: c.statement, status: c.status, confidence: c.confidence }));

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
