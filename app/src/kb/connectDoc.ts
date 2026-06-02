// Render a born-resolved entity node (SPEC-0020 §3.4, CONNECT-7/8) and the helpers Connect
// uses to place + fold + parse nodes. Hand-rolled YAML (flat + one nested `provenance`
// block) — no yaml dependency (ENG-5), matching sourceDoc.ts / claimDoc.ts.
//
// CANON-6: evergreen knowledge is for humans. The FILENAME is the human name
// (`entities/<kind>/<slug>.md`); identity is the stable `id:` in frontmatter, with the ULID
// (and folded-in prior spellings) under `aliases:` so id-search / old links keep resolving
// through renames and merges. Connect is the SOLE writer of `entities/` (CONNECT-3).
import path from 'node:path';
import type { AgentTrace } from './archivist';

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

/** Kind segment for the path: same slug treatment so `entities/<kind>/...` stays tidy. */
export function kindSlug(kind: string): string {
  return slugify(kind);
}

/**
 * Repo-relative path for an entity node: `entities/<kind>/<slug>.md`. `taken` lets the caller
 * pass already-used relative paths in this run so a within-kind collision deterministically
 * gets a short id suffix (`<slug>-<id6>.md`) — never a ULID-only filename (CANON-7).
 */
export function entityFileRel(kind: string, name: string, id: string, taken: ReadonlySet<string> = new Set()): string {
  const dir = path.join('entities', kindSlug(kind));
  const base = path.join(dir, `${slugify(name)}.md`);
  if (!taken.has(base)) return base;
  const suffixed = path.join(dir, `${slugify(name)}-${id.slice(0, 6).toLowerCase()}.md`);
  return suffixed;
}

export interface EntityNode {
  id: string; // stable canonical ULID (frontmatter identity; survives renames/merges)
  kind: string;
  name: string; // human canonical name (also the filename slug source)
  confidence: number;
  aliases: string[]; // ULID + prior names/spellings folded in (CANON-6)
  derivedFrom: string[]; // ALL contributing source dirs (CONNECT-8)
  resolvedFrom: string[]; // candidate ids this node consumed (lineage; CONNECT-8)
  createdAt: string; // ISO
  updatedAt: string; // ISO
  agent?: AgentTrace;
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
    `name: ${scalar(node.name)}`,
    `confidence: ${node.confidence}`,
    `aliases: ${flowSeq(node.aliases)}`,
    'provenance:',
    `  derivedFrom: ${flowSeq(node.derivedFrom)}`,
    `  resolvedFrom: ${flowSeq(node.resolvedFrom)}`,
    `  transformedBy: ${scalar(transformedByLabel(node.agent))}`,
    `createdAt: ${node.createdAt}`,
    `updatedAt: ${node.updatedAt}`,
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
  let createdAt = '';
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^id:\s*(.+)$/))) id = fmScalar(m[1]);
    else if ((m = line.match(/^kind:\s*(.+)$/))) kind = fmScalar(m[1]);
    else if ((m = line.match(/^name:\s*(.+)$/))) name = fmScalar(m[1]);
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^aliases:\s*(\[.*\])\s*$/))) aliases = fmSeq(m[1]);
    else if ((m = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/))) derivedFrom = fmSeq(m[1]);
    else if ((m = line.match(/^\s+resolvedFrom:\s*(\[.*\])\s*$/))) resolvedFrom = fmSeq(m[1]);
    else if ((m = line.match(/^createdAt:\s*(.+)$/))) createdAt = fmScalar(m[1]);
  }
  if (!id || !kind || !name) throw new Error('connect: entity node missing id/kind/name');
  return { id, kind, name, confidence, aliases, derivedFrom, resolvedFrom, createdAt };
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
