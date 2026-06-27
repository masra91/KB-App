// The curated-core metadata vocabulary (SPEC-0025 META-2/3/8) — the versioned, checked-in source
// of truth for the tag namespaces + Properties that the views/colors depend on. A small stable
// contract: Connect (and later Reflect) write Obsidian-native `tags:` + Properties against it;
// Bases/graph views read it. Kept in code (type-checked, testable) rather than a runtime `.kb/`
// file. Beyond the core, agents may coin EMERGENT tags freely (META-2) — they need no entry here.
//
// v1 curated set (PM-locked 06-27; KB-Lead confirming the exact key set in parallel — a tweak is a
// one-line change here): `type/`, `topic/` tag namespaces; `type`, `scope`, `status`, `sensitivity`,
// `created`, `updated` Properties. Emergent agent-coined properties are DEFERRED to v2 (v1 = curated
// keys only, no vocab sprawl). `sensitivity` value vocab tracks SPEC-0043 SENSE-A (internal/public).

/** Bump when the curated core changes so views have a versioned contract (META-8). v2 = +status,
 *  +sensitivity Properties (SPEC-0025 META v1 facet: key-value Properties). */
export const CURATED_VOCAB_VERSION = 2;

/** Curated tag namespaces the views/colors depend on (META-2). Emergent tags live outside these. */
export const CURATED_TAG_NAMESPACES = ['type', 'topic'] as const;

/** Curated frontmatter Property keys (the structured facet layer; META-1/2). The views/Bases query
 *  these; emergent properties are deferred (v1). `type` + the date keys are written from dedicated
 *  node fields; `scope`/`status`/`sensitivity` are the dynamic curated Properties carried per node. */
export const CURATED_PROPERTIES = ['type', 'scope', 'status', 'sensitivity', 'created', 'updated'] as const;

/** The dynamic curated Property keys a node carries in its `properties` bag (vs. `type`/dates, which
 *  derive from dedicated fields). These are the carry-forward facets (scope/status/sensitivity). */
export const DYNAMIC_CURATED_PROPERTIES = ['scope', 'status', 'sensitivity'] as const;
export type DynamicCuratedProperty = (typeof DYNAMIC_CURATED_PROPERTIES)[number];

/** Whether `key` is a curated Property the views depend on (vs. an emergent/foreign key, dropped in v1). */
export function isCuratedProperty(key: string): boolean {
  return (CURATED_PROPERTIES as readonly string[]).includes(key);
}

/** Whether `key` is a dynamic curated Property carried in a node's `properties` bag (scope/status/sensitivity). */
export function isDynamicCuratedProperty(key: string): key is DynamicCuratedProperty {
  return (DYNAMIC_CURATED_PROPERTIES as readonly string[]).includes(key);
}

/**
 * Normalize a tag to Obsidian's `tags:` rules (META-3): lowercase; spaces/underscores → `-`;
 * keep only letters, digits, `-`, and `/` (nesting); collapse repeats; trim stray separators.
 * Returns '' for a tag that normalizes to nothing (the caller filters those out — never emit a
 * bare/empty tag). Preserves nested namespaces (`Topic/Machine Learning` → `topic/machine-learning`).
 */
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-') // whitespace + underscores → hyphen
    .replace(/[^\p{L}\p{N}/-]+/gu, '') // drop anything not letter/digit/slash/hyphen
    .replace(/\/+/g, '/') // collapse repeated slashes
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/(^[/-]+)|([/-]+$)/g, '') // trim leading/trailing slash or hyphen
    .replace(/-*\/-*/g, '/'); // tidy hyphens hugging a slash boundary
}

/** The curated `type/<kind>` tag for an entity kind (the graph-coloring facet; META-2). '' if the
 *  kind normalizes to nothing. */
export function typeTag(kind: string): string {
  const k = normalizeTag(kind);
  return k ? `type/${k}` : '';
}

/** The top-level namespace of a (normalized) tag, e.g. `topic/ml` → `topic`. */
export function tagNamespace(tag: string): string {
  const slash = tag.indexOf('/');
  return slash === -1 ? tag : tag.slice(0, slash);
}

/** Whether a tag belongs to the curated core (its namespace is curated) vs. emergent (META-2). */
export function isCuratedTag(tag: string): boolean {
  return (CURATED_TAG_NAMESPACES as readonly string[]).includes(tagNamespace(tag));
}
