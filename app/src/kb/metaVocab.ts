// The curated-core metadata vocabulary (SPEC-0025 META-2/3/8) — the versioned, checked-in source
// of truth for the tag namespaces + Properties that the views/colors depend on. A small stable
// contract: Connect (and later Reflect) write Obsidian-native `tags:` + Properties against it;
// Bases/graph views read it. Kept in code (type-checked, testable) rather than a runtime `.kb/`
// file. Beyond the core, agents may coin EMERGENT tags freely (META-2) — they need no entry here.
//
// v1 curated set (PM-approved working scope; KB-Lead confirming exact namespaces in parallel —
// a tweak is a one-line change here): `type/`, `topic/` tag namespaces; `type`, `scope`,
// `created`, `updated` Properties. `status` + rich `sensitivity` inference are deferred.

/** Bump when the curated core changes so views have a versioned contract (META-8). */
export const CURATED_VOCAB_VERSION = 1;

/** Curated tag namespaces the views/colors depend on (META-2). Emergent tags live outside these. */
export const CURATED_TAG_NAMESPACES = ['type', 'topic'] as const;

/** Curated frontmatter Property keys (the structured facet layer; META-1/2). */
export const CURATED_PROPERTIES = ['type', 'scope', 'created', 'updated'] as const;

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
