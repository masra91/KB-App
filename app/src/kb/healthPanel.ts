// Health panel — a pure, deterministic **structural lint** over the canonical entity graph
// (SPEC-0035 HEALTH). v1 is the **passive dashboard** half (HEALTH-8): it *surfaces* structural
// health — orphans, dangling/dead links, sparse/thin (stub) entities — with **no model calls**
// (HEALTH-1) and **no fixes** (auto-fix HEALTH-2, the bounded job HEALTH-5, causality-ordered
// repair HEALTH-4, and the REFLECT handoff HEALTH-3 are deferred). It only calls the read-only
// RecallTools, so it's read-only by construction (mirrors explorePanel); the IPC handler (main) and
// the DOM view (renderer) are thin shells over it.
//
// The scan reads each entity node **once** and derives the whole-graph adjacency from its outgoing
// `[[wikilinks]]` (inbound = the reverse) — O(N) reads, never the O(N²) of per-node backlink walks.
import type { RecallTools, EntityHit } from './recall';
import { blockKey } from './connect';
import { isHealthFindingDismissed, type HealthDismissalDirective } from './directives';

/** The three structural finding classes (HEALTH §3) — the dismiss key + the remediation actions key off these. */
export type HealthFindingClass = 'orphan' | 'thin' | 'dangling';

/** A content-STABLE key for a finding (NOT a ULID): `<class>:<kind>|<normalizedName>` for an entity finding,
 *  `dangling:<fromName>→<target>` for a dead link. Stable across re-derive/replay so a dismissal (and a
 *  future remediation record) re-matches the same finding after the entity's ULID is reborn (SPEC-0050 lesson). */
export function healthFindingKey(cls: HealthFindingClass, f: HealthFinding | DanglingLink): string {
  if (cls === 'dangling') {
    const d = f as DanglingLink;
    const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
    return `dangling:${norm(d.fromName)}→${norm(d.target)}`;
  }
  const e = f as HealthFinding;
  return `${cls}:${blockKey(e.kind, e.name)}`;
}

/** A flagged entity (orphan / thin) — enough to render a row + click-through, never a raw id. */
export interface HealthFinding {
  rel: string; // entity node rel-path (stable focus key for Explore deep-link)
  id: string;
  name: string;
  kind: string;
  chars?: number; // prose length — set for thin/stub findings (drives the "stub · N chars" defect text)
}

/** A dead/dangling link: an entity's outgoing `[[target]]` that resolves to no known entity node. */
export interface DanglingLink {
  from: string; // the source entity's rel-path
  fromName: string; // the source entity's human name
  target: string; // the unresolved link target as written (path/name portion, post-alias-strip)
}

/** The structural health report — bounded lists for rendering + full counts for the readout. */
export interface HealthReport {
  scanned: number; // entities scanned
  orphans: HealthFinding[]; // 0 inbound + 0 outbound (bounded to FINDING_CAP)
  thin: HealthFinding[]; // sparse/stub entities (bounded)
  dangling: DanglingLink[]; // dead links (bounded)
  counts: { orphans: number; thin: number; dangling: number }; // FULL counts (lists may be capped)
}

/** Prose-body length below which an entity reads as a **stub/thin** node (HEALTH §3 stub). The spec
 *  leaves the exact threshold open; this is a deliberately small floor (≈a couple of sentences). */
export const THIN_BODY_CHARS = 280;
const ENTITY_SCAN_LIMIT = 2000; // bound the scan (mirrors explorePanel) — v1 perf is by construction
const FINDING_CAP = 50; // bound each rendered list; `counts` still reports the true total

/** Parse a wikilink target (`entities/kind/slug.md|Display Name` or a bare name) → its path/name part. */
function linkTargetPath(to: string): string {
  const bar = to.indexOf('|');
  return (bar === -1 ? to : to.slice(0, bar)).trim();
}

/** Extract `[[target]]` wikilink target paths from a node body (alias portion stripped). */
function extractLinkTargets(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    const t = linkTargetPath(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * The human-authored **prose** of a node, with the machinery removed: YAML frontmatter, the `# Heading`,
 * and the generated `kb:links` / `kb:claims` blocks (CONNECT-12 / CLAIMS-9) — so a node that is only a
 * heading + empty generated blocks measures as ~empty (a stub), not as "has content". Tolerant of a
 * missing frontmatter / blocks.
 */
function bodyProse(md: string): string {
  let s = md;
  s = s.replace(/^\uFEFF?---\n[\s\S]*?\n---\n?/, ''); // leading YAML frontmatter (tolerate a BOM)
  s = s.replace(/<!--\s*kb:links:start[\s\S]*?kb:links:end\s*-->/g, ''); // generated links block
  s = s.replace(/<!--\s*kb:claims:start[\s\S]*?kb:claims:end\s*-->/g, ''); // generated claims block
  s = s.replace(/^#\s+.*$/m, ''); // the `# Name` heading
  return s.trim();
}

const byName = (a: HealthFinding, b: HealthFinding): number => a.name.localeCompare(b.name);
const toFinding = (e: EntityHit): HealthFinding => ({ rel: e.rel, id: e.id, name: e.name, kind: e.kind });

/**
 * Build the structural health report (HEALTH-1, deterministic, no model calls). Reads all entities
 * once, derives the link adjacency, and flags orphans / dangling links / thin stubs. A node that can't
 * be read is skipped for content checks (can't assess) but still participates in adjacency — one bad
 * node never aborts the scan (ENG-16). Targets into `claims/` or `sources/` are not entity edges and
 * are ignored (they're never "dangling entity links").
 */
export async function buildHealthReport(
  tools: RecallTools,
  dismissals: Map<string, HealthDismissalDirective> = new Map(),
): Promise<HealthReport> {
  const all = await tools.entityLookup({ query: '', limit: ENTITY_SCAN_LIMIT });

  // Resolution maps: a link target may be a rel-path, a human name, or an alias (case-insensitive).
  const byRel = new Map<string, EntityHit>();
  const byKey = new Map<string, EntityHit>(); // name + aliases, lowercased
  for (const e of all) {
    byRel.set(e.rel, e);
    if (e.name) byKey.set(e.name.toLowerCase(), e);
    for (const a of e.aliases ?? []) if (a) byKey.set(a.toLowerCase(), e);
  }

  const outboundCount = new Map<string, number>(); // rel → # of distinct resolved outbound neighbors
  const inboundCount = new Map<string, number>(); // rel → # of distinct resolved inbound neighbors
  const dangling: DanglingLink[] = [];
  const thin: HealthFinding[] = [];

  for (const e of all) {
    let md: string | null = null;
    try {
      md = await tools.readNode({ rel: e.rel });
    } catch {
      md = null; // unreadable node → skip content checks, never throw (ENG-16)
    }

    const resolvedOut = new Set<string>();
    for (const t of md ? extractLinkTargets(md) : []) {
      if (t.startsWith('claims/') || t.startsWith('sources/')) continue; // not an entity↔entity edge
      const hit = byRel.get(t) ?? byKey.get(t.toLowerCase());
      if (hit && hit.rel !== e.rel) resolvedOut.add(hit.rel);
      else if (!hit) dangling.push({ from: e.rel, fromName: e.name, target: t }); // dead link (HEALTH §3)
    }
    if (resolvedOut.size > 0) outboundCount.set(e.rel, resolvedOut.size);
    for (const r of resolvedOut) inboundCount.set(r, (inboundCount.get(r) ?? 0) + 1);

    // Stub/thin: only assessable when the node is readable; a heading-only / empty-block node is thin.
    if (md !== null) {
      const proseLen = bodyProse(md).length;
      if (proseLen < THIN_BODY_CHARS) thin.push({ ...toFinding(e), chars: proseLen });
    }
  }

  // Orphan (HEALTH §3): a node with 0 resolved inbound AND 0 resolved outbound links.
  const orphans = all
    .filter((e) => (outboundCount.get(e.rel) ?? 0) === 0 && (inboundCount.get(e.rel) ?? 0) === 0)
    .map(toFinding)
    .sort(byName);
  thin.sort(byName);
  dangling.sort((a, b) => a.fromName.localeCompare(b.fromName) || a.target.localeCompare(b.target));

  // VUX-16: drop findings the Principal has dismissed — BEFORE capping + counting, so a dismissed item
  // never shows AND the readout count reflects the true remaining total (not the pre-dismissal one).
  const keep = (cls: HealthFindingClass, f: HealthFinding | DanglingLink): boolean =>
    !isHealthFindingDismissed(dismissals, healthFindingKey(cls, f));
  const orphansKept = orphans.filter((f) => keep('orphan', f));
  const thinKept = thin.filter((f) => keep('thin', f));
  const danglingKept = dangling.filter((d) => keep('dangling', d));

  return {
    scanned: all.length,
    orphans: orphansKept.slice(0, FINDING_CAP),
    thin: thinKept.slice(0, FINDING_CAP),
    dangling: danglingKept.slice(0, FINDING_CAP),
    counts: { orphans: orphansKept.length, thin: thinKept.length, dangling: danglingKept.length },
  };
}
