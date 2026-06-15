// SPEC-0051 slice-2 — entity-pair affinity scorer. PURE (no I/O) so it's deterministic and unit-
// testable on synthetic entity sets. Scores how related two entities are from GROUNDED in-vault
// signals only — never a guess:
//   • shared source provenance (`derivedFrom` overlap) — CO-MENTION: both entities were pulled from
//     the same source document. The strongest signal (concrete, grounded in real text).
//   • shared `topic/` tags (SPEC-0025 META + WS-C #368) — topical relatedness.
//   • shared neighbours in the existing link graph — two entities that both link to a common third.
//
// The central guard (the Principal's anti-hairball caution / QD-2's don't-false-link bar) is RARITY
// WEIGHTING: a signal shared by MANY entities is weak evidence and contributes little. A source that
// derives 2 entities strongly co-relates them; a 50-entity dump barely relates any pair. Likewise a
// `topic/disney` tag on 200 entities must NOT wire all 200 into a blob. Weight each shared signal by
// 1/(groupSize − 1) so broad signals decay toward zero — this is what keeps the orphan linker from
// manufacturing a hairball (which the SPEC-0051 cohesion metric would then flag as a regression).
//
// Shared by the SPEC-0051 orphan linker (slice-2) AND, by design, SPEC-0051 dedup (slice-3) +
// SPEC-0050 merge/distinct (DEV-7): same "candidate entities by shared signal" core, different
// decision on top (link vs merge). One impl, two callers — mirrors `mergeNodes` (Connect + Reflect).

/** The minimal entity view the scorer needs (built from a parsed entity node — pure data, no I/O). */
export interface AffinityEntity {
  /** Entity rel-path, e.g. `entities/person/grace-hopper.md` — the node identity. */
  id: string;
  /** Canonical display name (for tie-breaks / readable evidence). */
  name: string;
  /** Entity kind (person/org/…); a caller may require same-kind for a MERGE candidate. */
  kind: string;
  /** All contributing source dirs (CONNECT-8 `derivedFrom`) — the co-mention signal. */
  derivedFrom: string[];
  /** `topic/` tags only (the caller filters `tags` via `topicTagsOf`; `type/<kind>` is NOT a signal). */
  topicTags: string[];
}

/** A scored candidate related entity, with the grounded evidence that justifies the score. */
export interface AffinityCandidate {
  /** Candidate entity id. */
  id: string;
  /** Total rarity-weighted affinity (higher = more related). Always > 0 for a returned candidate. */
  score: number;
  /** Source dirs both entities derive from (the co-mention evidence). */
  sharedSources: string[];
  /** `topic/` tags both entities carry. */
  sharedTopicTags: string[];
  /** Common neighbour entity ids in the existing graph (both link to each). */
  sharedNeighbors: string[];
}

/** Tunable signal weights + gates. Defaults are conservative (favour precision — don't-false-link). */
export interface AffinityOptions {
  /** Per-shared-source base weight (before rarity decay). Co-mention is the strongest signal. */
  sourceWeight?: number;
  /** Per-shared-topic-tag base weight. Topical, weaker than direct co-mention. */
  topicWeight?: number;
  /** Per-shared-neighbour base weight (decayed by the neighbour's degree — a shared HUB counts little). */
  neighborWeight?: number;
}

const DEFAULTS: Required<AffinityOptions> = {
  sourceWeight: 1.0,
  topicWeight: 0.5,
  neighborWeight: 0.5,
};

/** Filter an entity's `tags` to the `topic/` namespace — the only tag class that signals relatedness
 *  (a `type/<kind>` tag shared by every person is not evidence two persons are related). */
export function topicTagsOf(tags: readonly string[]): string[] {
  return tags.filter((t) => t.startsWith('topic/'));
}

function intersect(a: readonly string[], b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of a) {
    if (b.has(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Score every other entity's affinity to `targetId` from the grounded signals, rarity-weighted.
 * Returns only candidates with a strictly positive score (≥1 shared signal), sorted by score
 * descending then id ascending (fully deterministic). `edges` is the existing undirected link graph
 * used for the shared-neighbour signal (pass `[]` to skip it — orphans have no neighbours anyway).
 *
 * Rarity: a source/tag shared by `g` entities contributes `weight/(g−1)` per pair — so a 2-entity
 * source (g=2) contributes the full weight, a broad source decays toward 0. A common neighbour of
 * degree `d` contributes `neighborWeight/d`. This is the anti-hairball core: broad signals can't
 * over-link.
 */
export function scoreAffinities(
  targetId: string,
  entities: readonly AffinityEntity[],
  edges: ReadonlyArray<{ from: string; to: string }> = [],
  options: AffinityOptions = {},
): AffinityCandidate[] {
  const opts = { ...DEFAULTS, ...options };
  const byId = new Map<string, AffinityEntity>();
  for (const e of entities) if (!byId.has(e.id)) byId.set(e.id, e);
  const target = byId.get(targetId);
  if (!target) return [];

  // Group sizes for rarity weighting: how many entities derive from each source / hold each topic tag.
  const sourceGroup = new Map<string, number>();
  const topicGroup = new Map<string, number>();
  for (const e of byId.values()) {
    for (const s of new Set(e.derivedFrom)) sourceGroup.set(s, (sourceGroup.get(s) ?? 0) + 1);
    for (const t of new Set(e.topicTags)) topicGroup.set(t, (topicGroup.get(t) ?? 0) + 1);
  }

  // Undirected adjacency + degree for the shared-neighbour signal.
  const adj = new Map<string, Set<string>>();
  const addAdj = (x: string, y: string): void => {
    if (x === y) return;
    let s = adj.get(x);
    if (!s) {
      s = new Set();
      adj.set(x, s);
    }
    s.add(y);
  };
  for (const e of edges) {
    addAdj(e.from, e.to);
    addAdj(e.to, e.from);
  }
  const targetNbrs = adj.get(targetId) ?? new Set<string>();

  const targetSources = new Set(target.derivedFrom);
  const targetTopics = new Set(target.topicTags);

  const out: AffinityCandidate[] = [];
  for (const cand of byId.values()) {
    if (cand.id === targetId) continue;

    const sharedSources = intersect(cand.derivedFrom, targetSources);
    const sharedTopicTags = intersect(cand.topicTags, targetTopics);
    const candNbrs = adj.get(cand.id);
    const sharedNeighbors = candNbrs ? [...targetNbrs].filter((n) => candNbrs.has(n)).sort() : [];
    if (sharedSources.length === 0 && sharedTopicTags.length === 0 && sharedNeighbors.length === 0) continue;

    let score = 0;
    for (const s of sharedSources) {
      const g = sourceGroup.get(s) ?? 1;
      if (g > 1) score += opts.sourceWeight / (g - 1); // g=2 ⇒ full weight; broad source ⇒ ~0
    }
    for (const t of sharedTopicTags) {
      const g = topicGroup.get(t) ?? 1;
      if (g > 1) score += opts.topicWeight / (g - 1);
    }
    for (const n of sharedNeighbors) {
      const d = (adj.get(n)?.size ?? 0) || 1;
      score += opts.neighborWeight / d; // a shared HUB (high degree) counts little
    }

    if (score > 0) out.push({ id: cand.id, score, sharedSources, sharedTopicTags, sharedNeighbors });
  }

  out.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** A planned set of discovered links for one orphan entity (capped + thresholded + ordered). */
export interface OrphanLinkPlan {
  /** The orphan entity id getting new discovered links. */
  orphan: string;
  /** The chosen candidates (each ≥ minScore, ≤ maxLinksPerOrphan of them), strongest first. */
  links: AffinityCandidate[];
}

export interface OrphanLinkOptions extends AffinityOptions {
  /** A candidate must score at least this to be linked — below it the orphan stays unlinked (no
   *  false link, no review spam). The primary precision gate alongside rarity weighting. Default 0.2. */
  minScore?: number;
  /** At most this many discovered links per orphan — the hard degree cap that bounds how dense the
   *  linker can make the graph (anti-hairball). Default 3. */
  maxLinksPerOrphan?: number;
  /** Orphan ids to leave alone — e.g. nodes that carry stated `relatesTo` hints (owned by the
   *  deterministic link-promotion pass, CONNECT-12/13). Keeps the two passes' domains disjoint so
   *  neither clobbers the other's link block. */
  skip?: ReadonlySet<string>;
  /**
   * Injectable suppression seam (SPEC-0050 coordination, DEV-7): return `true` to FORBID linking a
   * pair the Principal has settled as `distinct`. Called for every (orphan, candidate) pair we'd
   * otherwise link; a blocked candidate is dropped (the orphan may still link to its other
   * candidates). Default: nothing blocked — so the linker is correct with no directive store present
   * (an absent file ⇒ link freely). DEV-7's `pairDirective` lookup wires in here at the call site.
   */
  blocked?: (a: AffinityEntity, b: AffinityEntity) => boolean;
}

const ORPHAN_DEFAULTS = { minScore: 0.2, maxLinksPerOrphan: 3 };

/**
 * Plan discovered links for the ORPHAN tail (SPEC-0051 slice-2 "the prize"). An orphan is a
 * degree-0 node in the existing entity graph (`edges`). For each eligible orphan we take its
 * top-scoring affinity candidates (grounded co-mention / shared-topic evidence), keeping only those
 * at or above `minScore` and at most `maxLinksPerOrphan` of them. An orphan with no qualifying
 * candidate is omitted entirely — it stays unlinked rather than getting a guessed link (the
 * don't-false-link bar). Fully deterministic: orphans are processed in id order and candidates are
 * pre-sorted by (score desc, id asc). `skip` excludes ids the caller owns elsewhere.
 */
export function planOrphanLinks(
  entities: readonly AffinityEntity[],
  edges: ReadonlyArray<{ from: string; to: string }>,
  options: OrphanLinkOptions = {},
): OrphanLinkPlan[] {
  const minScore = options.minScore ?? ORPHAN_DEFAULTS.minScore;
  const maxLinks = Math.max(1, Math.floor(options.maxLinksPerOrphan ?? ORPHAN_DEFAULTS.maxLinksPerOrphan));
  const skip = options.skip ?? new Set<string>();

  const ids = entities.map((e) => e.id);
  const idSet = new Set(ids);
  const degree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  const blocked = options.blocked;
  const byId = new Map<string, AffinityEntity>();
  for (const e of entities) if (!byId.has(e.id)) byId.set(e.id, e);

  const orphans = ids.filter((id) => (degree.get(id) ?? 0) === 0 && !skip.has(id)).sort();
  const plans: OrphanLinkPlan[] = [];
  for (const orphan of orphans) {
    const self = byId.get(orphan)!;
    const links = scoreAffinities(orphan, entities, edges, options)
      .filter((c) => c.score >= minScore)
      .filter((c) => !blocked || !blocked(self, byId.get(c.id)!)) // never link a settled-distinct pair (SPEC-0050)
      .slice(0, maxLinks);
    if (links.length > 0) plans.push({ orphan, links });
  }
  return plans;
}
