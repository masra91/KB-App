// The graph projection (SPEC-0058 STATE-2) — the maintained, precomputed knowledge-graph snapshot that
// Explore and Health read INSTEAD of walking the git vault live on every mount.
//
// The packaged-app P0 (#451 stopped the bleed) was that Explore + Health scanned `entities/`+`claims/`
// LIVE per render: Explore's incoming-link backlink scan is O(N+M) PER focus, Health re-walks every
// node — so a cold/large vault blew the load budget and the views failed to load. This module moves that
// work OFF the render path: `computeGraphProjection` does ONE pass on the settled tree (read each entity
// node once, extract its outgoing `[[wikilinks]]`, and INVERT them into precomputed backlinks), producing
// a `GraphProjection`. `makeProjectionTools` then serves the existing read-only `RecallTools` surface
// PURELY from that in-memory snapshot — so the proven `buildNeighborhood` (Explore) and `buildHealthReport`
// (Health) assembly runs unchanged, with zero filesystem access and an O(degree) backlink lookup.
//
// Lane (SPEC-0058 scale-up): graph-projection AUTHORSHIP is DEV-3's (STATE-2); it is the shared substrate
// Health (STATE-3, DEV-2) derives from read-only. The generic ProjectionStore backbone + envelope +
// invalidation + push + persistence are the CORE's (DEV-5, STATE-1/6/7/8/11/12) — this module is a PURE
// function `(RecallTools) → GraphProjection` plus its read adapter, plugged into that store as `compute`.
import type { RecallTools, EntityHit, ClaimHit, LinkHit, GrepHit } from './recall';

/** A precomputed, serializable snapshot of the evergreen knowledge graph (STATE-2). Carries exactly what
 *  the Explore + Health surfaces consume — entities, per-node markdown (predicates / thin-detection),
 *  PRECOMPUTED backlinks (the O(N²)-once that kills the per-mount re-walk), claims, and cited-source
 *  markdown (for citation titles). Plain records (no Map) so it persists to JSON for instant cold start. */
export interface GraphProjection {
  /** Every entity node (the same `EntityHit` shape `entityLookup` returns), unsorted. */
  entities: EntityHit[];
  /** entity rel-path → its raw node markdown (serves `readNode`: center predicates + Health thin/link scan). */
  entityMd: Record<string, string>;
  /** entity rel-path → its PRECOMPUTED incoming backlinks (every entity/claim file literally containing
   *  `[[<rel>]]`). This is the inverted edge index — the live O(N+M) per-focus scan, done once. */
  backlinks: Record<string, LinkHit[]>;
  /** Every claim (the `ClaimHit` shape `claimsForEntity` returns). */
  claims: ClaimHit[];
  /** source dir → its `source.md` text (serves `readSource` for citation-title derivation). */
  sourceMd: Record<string, string>;
  /** ISO timestamp the snapshot was computed (provenance; the store's envelope also stamps `builtAt`). */
  builtAt?: string;
}

/** Extract `[[target]]` wikilink targets from a node body. Replicated verbatim from `recallTools` (kept
 *  local to avoid a cross-file export edit in the parallel rewrite); the equivalence test pins it identical. */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Compute the graph projection from a live read-only tool surface (STATE-2). Runs the expensive work ONCE
 * (off the render path, on the projection store's cadence / canonical-advance): reads every entity node and
 * claim once, then precomputes each entity's incoming backlinks by the SAME literal-`[[rel]]` test the live
 * `linkTraversal` uses — so the projection-backed neighborhood is byte-identical to the live one, minus the
 * per-mount cost. `now` is injectable for deterministic tests.
 */
export async function computeGraphProjection(tools: RecallTools, now: () => string = () => new Date().toISOString()): Promise<GraphProjection> {
  // One scan of all entities (the same call Explore/Health make), held as the projection's entity set.
  const entities = await tools.entityLookup({ query: '', limit: ENTITY_SCAN_LIMIT });

  // Read each entity node once (its md serves predicates for Explore + link/thin scan for Health).
  const entityMd: Record<string, string> = {};
  for (const e of entities) {
    const md = await tools.readNode({ rel: e.rel });
    if (typeof md === 'string') entityMd[e.rel] = md;
  }

  // Gather every claim once (subject-keyed reads stay O(1) later); read each claim's md too so backlink
  // inversion can see claim→entity links (the live `incoming` scans entities AND claims).
  const claims = await collectAllClaims(tools, entities);
  const claimMd: Record<string, string> = {};
  for (const c of claims) {
    const md = await tools.readNode({ rel: c.rel });
    if (typeof md === 'string') claimMd[c.rel] = md;
  }

  // PRECOMPUTE backlinks: for each entity, every entity/claim file whose body literally contains `[[rel]]`
  // (mirrors recallTools.linkTraversal's incoming test exactly — including its piped-link asymmetry). The
  // O(N·(N+M)) cost lives HERE, once per refresh, not on every Explore load.
  const backlinks: Record<string, LinkHit[]> = {};
  const files: Array<{ rel: string; md: string }> = [
    ...Object.entries(entityMd).map(([rel, md]) => ({ rel, md })),
    ...Object.entries(claimMd).map(([rel, md]) => ({ rel, md })),
  ];
  for (const e of entities) {
    const target = `[[${e.rel}]]`;
    const hits: LinkHit[] = [];
    for (const f of files) {
      if (f.rel === e.rel) continue;
      if (f.md.includes(target)) hits.push({ from: f.rel, to: e.rel });
    }
    backlinks[e.rel] = hits;
  }

  // Cited sources: read each unique `derivedFrom` source dir's source.md once (for citation titles).
  const sourceMd: Record<string, string> = {};
  const sourceDirs = new Set<string>();
  for (const c of claims) for (const d of c.derivedFrom ?? []) if (typeof d === 'string' && d.trim()) sourceDirs.add(d);
  for (const dir of sourceDirs) {
    const md = await tools.readSource({ dir });
    if (typeof md === 'string') sourceMd[dir] = md;
  }

  return { entities, entityMd, backlinks, claims, sourceMd, builtAt: now() };
}

/** The same generous entity cap the live read surface uses (recallTools/explorePanel ENTITY_SCAN_LIMIT). */
const ENTITY_SCAN_LIMIT = 2000;

/** Collect every claim across all entities, deduped by claim rel (the projection holds the full claim set
 *  so `claimsForEntity` is a pure in-memory filter). Uses the live `claimsForEntity` per entity — bounded
 *  and run ONCE at compute time, never on the render path. */
async function collectAllClaims(tools: RecallTools, entities: EntityHit[]): Promise<ClaimHit[]> {
  const byRel = new Map<string, ClaimHit>();
  for (const e of entities) {
    const cs = await tools.claimsForEntity({ entity: e.rel, limit: CLAIM_COLLECT_LIMIT });
    for (const c of cs) if (!byRel.has(c.rel)) byRel.set(c.rel, c);
  }
  return [...byRel.values()];
}

/** A high per-entity claim cap for the one-time collection pass (well above any real entity's claim count). */
const CLAIM_COLLECT_LIMIT = 1000;

/**
 * Serve the read-only `RecallTools` surface PURELY from a precomputed {@link GraphProjection} — zero
 * filesystem, O(degree) backlink lookup. Drop-in for `makeReadOnlyTools(root)` so `buildNeighborhood`
 * (Explore) and `buildHealthReport` (Health) run VERBATIM against the projection (no logic divergence; the
 * equivalence test proves identical output). `grep` is a no-op (Explore/Health never call it).
 */
export function makeProjectionTools(graph: GraphProjection): RecallTools {
  const entities = graph.entities;
  const byRelName = (entity: string): string | null => {
    if (typeof entity !== 'string' || entity.length === 0) return null;
    // A rel-path that is a known entity resolves to itself (mirrors resolveEntityRel's rel branch).
    if (entity.includes('/') && entity.endsWith('.md') && Object.prototype.hasOwnProperty.call(graph.entityMd, entity)) return entity;
    const needle = entity.toLowerCase();
    const match =
      entities.find((e) => e.name.toLowerCase() === needle || e.aliases.some((a) => a.toLowerCase() === needle)) ??
      entities.find((e) => e.name.toLowerCase().includes(needle));
    return match ? match.rel : null;
  };

  return {
    async entityLookup({ query, kind, limit }) {
      const needle = (query ?? '').toLowerCase();
      return entities
        .filter((e) => !kind || e.kind.toLowerCase() === kind.toLowerCase())
        .filter((e) => needle.length === 0 || e.name.toLowerCase().includes(needle) || e.aliases.some((a) => a.toLowerCase().includes(needle)))
        .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
        .slice(0, limit ?? ENTITY_SCAN_LIMIT);
    },
    async claimsForEntity({ entity, limit }) {
      const rel = byRelName(entity);
      if (!rel) return [];
      return graph.claims.filter((c) => c.subject === rel).slice(0, limit ?? CLAIM_COLLECT_LIMIT);
    },
    async linkTraversal({ entity }) {
      const rel = byRelName(entity);
      if (!rel) return { outgoing: [], incoming: [] };
      const md = graph.entityMd[rel] ?? '';
      const outgoing: LinkHit[] = extractWikilinks(md).map((to) => ({ from: rel, to }));
      const incoming = graph.backlinks[rel] ?? [];
      return { outgoing, incoming };
    },
    async readNode({ rel }) {
      return graph.entityMd[rel] ?? null;
    },
    async readSource({ dir }) {
      const key = dir.endsWith('source.md') ? dir.slice(0, -'/source.md'.length) : dir;
      return graph.sourceMd[dir] ?? graph.sourceMd[key] ?? null;
    },
    async grep(): Promise<GrepHit[]> {
      return [];
    },
  };
}
