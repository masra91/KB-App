// Render a born-resolved entity node (SPEC-0020 §3.4, CONNECT-7/8) and the helpers Connect
// uses to place + fold + parse nodes. Hand-rolled YAML (flat + one nested `provenance`
// block) — no yaml dependency (ENG-5), matching sourceDoc.ts / claimDoc.ts.
//
// CANON-6: evergreen knowledge is for humans. The FILENAME is the human name — real case + spaces
// (`entities/<kind>/<Human Name>.md`, COMPOSE-6); identity is the stable `id:` in frontmatter, with the ULID
// (and folded-in prior spellings) under `aliases:` so id-search / old links keep resolving
// through renames and merges. Connect is the SOLE writer of `entities/` (CONNECT-3).
import path from 'node:path';
import type { AgentTrace } from './archivist';
import { CLAIMS_BLOCK_START } from './claimDoc';
import { DYNAMIC_CURATED_PROPERTIES, isDynamicCuratedProperty } from './metaVocab';

/** Quote a scalar only when it contains YAML-significant characters. */
function scalar(s: string): string {
  return /[:#'"\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** A YAML flow-sequence of quoted strings, e.g. `["a", "b"]`. */
function flowSeq(items: string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

/** A truthful `transformedBy` from the decision's agent trace (ORCH-16). */
export function transformedByLabel(agent?: AgentTrace): string {
  if (agent?.via === 'copilot') return `connect · copilot (${agent.model ?? 'default'})`;
  return 'connect';
}

/**
 * Slugify a name for an Obsidian-friendly human filename: lowercase, spaces→hyphens, drop
 * punctuation, collapse hyphens. Identity is the `id:`, not the filename (CANON-6), so this
 * is purely cosmetic — a collision within a kind is disambiguated by a short id suffix
 * (entityFileRel), never by reverting to a ULID filename (CANON-7).
 */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'unnamed';
}

/** Kind segment for the path: a lowercase slug so the *directory* `entities/<kind>/...` stays tidy
 *  (`entities/organization/...`). Only the leaf FILENAME is the human name (entityFileName). */
export function kindSlug(kind: string): string {
  return slugify(kind);
}

/**
 * COMPOSE-6 (SPEC-0046) / PRIN-24 / CANON-6: the human leaf filename for an entity — the **natural
 * name with real case + spaces preserved** (`Steve Jobs.md`), NOT a kebab-slug (`steve-jobs.md`).
 * Identity is the `id:` (the ULID + folded aliases), so the filename is purely cosmetic and free to
 * be human; Obsidian opens spaces/case fine. We only strip characters a path / Obsidian wikilink
 * cannot hold (`/ \ : * ? " < > |` and the wikilink-significant `# ^ [ ]` + control chars), collapse
 * the resulting whitespace, drop leading/trailing dots+spaces (hidden-file / Windows hazards), and
 * cap length. Case is **never** folded (so `iPhone`, `NASA`, `von Neumann` survive). Empty → `Unnamed`.
 */
export function entityFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- strip C0 control chars from the human filename
    .replace(/[/\\:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trimEnd()
    .slice(0, 120)
    .replace(/[.\s]+$/, '');
  return cleaned.length > 0 ? cleaned : 'Unnamed';
}

/**
 * Repo-relative path for an entity node: `entities/<kind>/<Human Name>.md` (COMPOSE-6 — the leaf is
 * the human name, the kind dir stays a lowercase slug). `taken` lets the caller pass already-used
 * relative paths in this run so a within-kind collision deterministically gets a short id suffix
 * (`<Human Name> (<id6>).md`) — never a ULID-only filename (CANON-7).
 */
export function entityFileRel(kind: string, name: string, id: string, taken: ReadonlySet<string> = new Set()): string {
  const dir = path.join('entities', kindSlug(kind));
  const leaf = entityFileName(name);
  const base = path.join(dir, `${leaf}.md`);
  if (!taken.has(base)) return base;
  const suffixed = path.join(dir, `${leaf} (${id.slice(0, 6).toLowerCase()}).md`);
  return suffixed;
}

export interface EntityNode {
  id: string; // stable canonical ULID (frontmatter identity; survives renames/merges)
  kind: string;
  name: string; // human canonical name (also the source for the human leaf filename, entityFileName)
  confidence: number;
  aliases: string[]; // ULID + prior names/spellings folded in (CANON-6)
  derivedFrom: string[]; // ALL contributing source dirs (CONNECT-8)
  resolvedFrom: string[]; // candidate ids this node consumed (lineage; CONNECT-8)
  tags: string[]; // Obsidian `tags:` — curated `type/<kind>` + emergent topic tags (SPEC-0025 META-1/2)
  /** Dynamic curated key-value Properties carried per node (SPEC-0025 META v1: `scope`/`status`/
   *  `sensitivity`). Obsidian-native flat frontmatter Properties the views/Bases query. Only curated keys
   *  are emitted (emergent props deferred to v2); absent/empty values are omitted. `type` + the dates are
   *  written from their own dedicated fields, not this bag. */
  properties?: Record<string, string>;
  createdAt: string; // ISO — written as the Obsidian-native `created` Property (META-2)
  updatedAt: string; // ISO — written as the Obsidian-native `updated` Property (META-2)
  agent?: AgentTrace;
}

/** The dynamic curated Property lines for a node's identity frontmatter (SPEC-0025 META): each present,
 *  non-empty curated key (`scope`/`status`/`sensitivity`) rendered as a flat Obsidian Property, in the
 *  fixed curated order (deterministic output). Absent/foreign keys are omitted. */
function curatedPropertyLines(properties: Record<string, string> | undefined): string[] {
  if (!properties) return [];
  const out: string[] = [];
  for (const key of DYNAMIC_CURATED_PROPERTIES) {
    const v = properties[key];
    if (typeof v === 'string' && v.trim().length > 0) out.push(`${key}: ${scalar(v.trim())}`);
  }
  return out;
}

export const NODE_BODY_MARK = ''; // body begins with the H1; blocks (claims/links) appended later

/**
 * Render a canonical entity node's markdown (identity frontmatter + H1). The generated claims
 * block (CLAIMS-9) and the deferred links block (CONNECT-12) are appended by their owners;
 * Connect writes identity once. A fresh node's body is just the heading.
 */
export function renderEntityNode(node: EntityNode): string {
  const fm: string[] = [
    `id: ${node.id}`,
    `kind: ${scalar(node.kind)}`,
    // Curated `type` Property (SPEC-0025 META-2): the views' filter key, seeded from `kind`.
    `type: ${scalar(node.kind)}`,
    `name: ${scalar(node.name)}`,
    `confidence: ${node.confidence}`,
    `aliases: ${flowSeq(node.aliases)}`,
    // Obsidian-native `tags:` (META-1/3): curated `type/<kind>` + emergent topic tags. The graph
    // colors + Bases filter off these. A node always has at least its `type/<kind>` tag.
    `tags: ${flowSeq(node.tags)}`,
    // Dynamic curated key-value Properties (SPEC-0025 META v1): scope/status/sensitivity, when carried.
    ...curatedPropertyLines(node.properties),
    'provenance:',
    `  derivedFrom: ${flowSeq(node.derivedFrom)}`,
    `  resolvedFrom: ${flowSeq(node.resolvedFrom)}`,
    `  transformedBy: ${scalar(transformedByLabel(node.agent))}`,
    // Obsidian-native curated date Properties (META-2): `created`/`updated` (were `createdAt`/`updatedAt`
    // — migrated to the curated names so Bases/graph can date-sort/filter; parse still reads the legacy
    // names for back-compat fold-in).
    `created: ${node.createdAt}`,
    `updated: ${node.updatedAt}`,
  ];
  return `---\n${fm.join('\n')}\n---\n\n# ${node.name}\n`;
}

// ── Parsing an existing node (for fold-in / merge; CONNECT-9/10) ───────────────────────────

export interface ParsedNode {
  id: string;
  kind: string;
  name: string;
  confidence: number;
  aliases: string[];
  derivedFrom: string[];
  resolvedFrom: string[];
  tags: string[];
  /** Dynamic curated key-value Properties read back (scope/status/sensitivity); foreign keys dropped. */
  properties: Record<string, string>;
  createdAt: string;
}

function fmScalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t;
    }
  }
  return t;
}

function fmSeq(raw: string): string[] {
  try {
    const arr = JSON.parse(raw.trim()) as unknown[];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Parse the identity frontmatter of an existing entity node enough to fold/merge into it
 * (CONNECT-9/10). Tolerant: only the fields Connect needs. Throws if id/kind/name are missing
 * (a foreign / malformed node — skipped by the caller, not crashed on).
 */
export function parseEntityNode(md: string): ParsedNode {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = fmEnd === -1 ? md : md.slice(0, fmEnd);
  let id = '';
  let kind = '';
  let name = '';
  let confidence = 0;
  let aliases: string[] = [];
  let derivedFrom: string[] = [];
  let resolvedFrom: string[] = [];
  let tags: string[] = [];
  const properties: Record<string, string> = {};
  let createdAt = '';
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^id:\s*(.+)$/))) id = fmScalar(m[1]);
    else if ((m = line.match(/^kind:\s*(.+)$/))) kind = fmScalar(m[1]);
    else if ((m = line.match(/^name:\s*(.+)$/))) name = fmScalar(m[1]);
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^aliases:\s*(\[.*\])\s*$/))) aliases = fmSeq(m[1]);
    else if ((m = line.match(/^tags:\s*(\[.*\])\s*$/))) tags = fmSeq(m[1]);
    else if ((m = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/))) derivedFrom = fmSeq(m[1]);
    else if ((m = line.match(/^\s+resolvedFrom:\s*(\[.*\])\s*$/))) resolvedFrom = fmSeq(m[1]);
    // Obsidian-native curated `created` (META-2), or the legacy `createdAt` (back-compat fold-in).
    else if ((m = line.match(/^created:\s*(.+)$/))) createdAt = fmScalar(m[1]);
    else if ((m = line.match(/^createdAt:\s*(.+)$/))) createdAt = createdAt || fmScalar(m[1]);
    // Dynamic curated key-value Properties (scope/status/sensitivity) — only curated keys are kept.
    else if ((m = line.match(/^([a-z]+):\s*(.+)$/)) && isDynamicCuratedProperty(m[1])) properties[m[1]] = fmScalar(m[2]);
  }
  if (!id || !kind || !name) throw new Error('connect: entity node missing id/kind/name');
  return { id, kind, name, confidence, aliases, derivedFrom, resolvedFrom, tags, properties, createdAt };
}

/** Union helper preserving order, de-duplicated — for folding derivedFrom/resolvedFrom/aliases. */
export function unionOrdered(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ── The entity node's generated links block (CONNECT-12) ────────────────────────────────────
//
// Connect promotes Claims' soft `relatesTo` hints into real Obsidian `[[wikilinks]]` between
// canonical nodes, so the graph view connects (CONNECT-12). Like the claims block (CLAIMS-9) it
// is a delimited, regenerated-WHOLE block — re-pokes/replays converge and human edits inside the
// markers are expected to be overwritten. Connect owns this block; Claims owns the claims block.

export const LINKS_BLOCK_START = '<!-- kb:links:start (generated — edit via Connect, not here) -->';
export const LINKS_BLOCK_END = '<!-- kb:links:end -->';

/** One reconciled relation rendered into the node's links block: a wikilink to a canonical node. */
export interface NodeLink {
  targetRel: string; // repo-relative path of the resolved canonical node (the [[wikilink]] target)
  predicate?: string; // optional link text prefix (relatesTo hints are bare names in v1 → usually absent)
  name?: string; // display name for the Obsidian alias form `[[path|Name]]` (VAULT-12)
}

/** The generated links block (CONNECT-12), regenerated WHOLE. A node with hints but no resolved
 *  target still gets a (placeholder) block so re-runs are idempotent (mirrors the claims block).
 *  VAULT-12: a link with a known display name renders as the Obsidian alias form `[[path|Name]]`
 *  — resolves by path (collision-safe) but shows the entity name, not the raw ULID/path. */
export function renderLinksBlock(links: readonly NodeLink[]): string {
  const rows =
    links.length === 0
      ? ['_No resolved links yet._']
      : links.map((l) => {
          const link = l.name ? `[[${l.targetRel}|${l.name}]]` : `[[${l.targetRel}]]`;
          return l.predicate ? `- ${l.predicate} ${link}` : `- ${link}`;
        });
  return [LINKS_BLOCK_START, ...rows, LINKS_BLOCK_END].join('\n');
}

/** Remove any existing generated links block (and surrounding blank lines) from a node. */
export function stripLinksBlock(nodeMd: string): string {
  const start = nodeMd.indexOf(LINKS_BLOCK_START);
  if (start === -1) return nodeMd;
  const endMarker = nodeMd.indexOf(LINKS_BLOCK_END, start);
  const end = endMarker === -1 ? nodeMd.length : endMarker + LINKS_BLOCK_END.length;
  return (nodeMd.slice(0, start) + nodeMd.slice(end)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/**
 * Idempotently (re)write the generated links block in an entity node (CONNECT-12). Strips any
 * prior links block, then inserts the freshly-regenerated one in a STABLE position — immediately
 * BEFORE the claims block when present (matching SPEC-0020 §3.4 node layout), else at the end.
 * Stable placement is what keeps the node byte-identical across re-pokes when nothing changed and
 * prevents order-thrash with the claims block (which `applyClaimsBlock` always appends last).
 * Identity frontmatter + `# Name` heading are never altered.
 */
export function applyLinksBlock(nodeMd: string, links: readonly NodeLink[]): string {
  const stripped = stripLinksBlock(nodeMd);
  const block = renderLinksBlock(links);
  const claimsAt = stripped.indexOf(CLAIMS_BLOCK_START);
  if (claimsAt === -1) {
    return `${stripped.replace(/\s+$/, '')}\n\n${block}\n`;
  }
  const before = stripped.slice(0, claimsAt).replace(/\s+$/, '');
  const after = stripped.slice(claimsAt).replace(/^\s+/, '');
  return `${before}\n\n${block}\n\n${after}`;
}
