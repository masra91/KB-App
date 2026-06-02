// The read-only KB tool surface the recall agent navigates (SPEC-0026 ASK-4/5). Every method
// READS the evergreen graph (sources/entities/claims); none mutates it — so ASK-3 (read-only
// w.r.t. the ontology) holds by construction: there is simply no write path here.
//
// Tools wrap the on-disk layout directly (lightweight — `parseEntityNode` from connectDoc + a
// tolerant claim parser), so recall does not depend on the autonomous stage machinery. Tag/
// property filters (SPEC-0025 META) and the Obsidian CLI accelerator (ASK-9) are intentionally
// NOT registered yet — capability-gated until those land; they slot in without changing the loop.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEntityNode } from './connectDoc';
import { resolveContainedRel } from './pathContainment';
import type { RecallTools, EntityHit, ClaimHit, LinkHit, GrepHit } from './recall';

const DEFAULT_ENTITY_LIMIT = 10;
const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_GREP_LIMIT = 50;
const GREP_EXTS = new Set(['.md', '.txt']);

// Path containment for the LLM-/index-supplied `rel`s these read tools resolve now lives in the
// shared, symlink-safe helper (SPEC-0030 / #30): `resolveContainedRel` returns the abs path or null
// (skip) — reads never throw. It hardens the old lexical `safeResolve` against committed-symlink
// escapes too (a symlinked vault file could otherwise surface host content as "cited KB content").

/** Recursively collect files under `dir` (repo-relative to `root`) matching `keep`. */
async function walkFiles(root: string, dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await rec(full);
      else if (e.isFile() && keep(e.name)) out.push(path.relative(root, full));
    }
  }
  await rec(path.join(root, dir));
  return out;
}

// ── A tolerant claim-file parser (claimDoc.ts only renders; recall needs to read) ───────────

export interface ParsedClaim {
  id: string;
  subject: string; // repo-relative path to the subject entity node
  status: string;
  confidence: number;
  derivedFrom: string[];
  mentions: string[];
  relatesTo: string[];
  statement: string; // body (one line)
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

/** Parse a claim `.md` (frontmatter + one-line statement body). Throws on a non-claim doc. */
export function parseClaimMd(md: string): ParsedClaim {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = fmEnd === -1 ? md : md.slice(0, fmEnd);
  const body = fmEnd === -1 ? '' : md.slice(fmEnd + 4);
  let id = '';
  let subject = '';
  let status = '';
  let confidence = 0;
  let derivedFrom: string[] = [];
  let mentions: string[] = [];
  let relatesTo: string[] = [];
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^id:\s*(.+)$/))) id = fmScalar(m[1]);
    else if ((m = line.match(/^subject:\s*(.+)$/))) subject = fmScalar(m[1]);
    else if ((m = line.match(/^status:\s*(.+)$/))) status = fmScalar(m[1]);
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/))) derivedFrom = fmSeq(m[1]);
    else if ((m = line.match(/^\s+mentions:\s*(\[.*\])\s*$/))) mentions = fmSeq(m[1]);
    else if ((m = line.match(/^relatesTo:\s*(\[.*\])\s*$/))) relatesTo = fmSeq(m[1]);
  }
  if (!id || !subject) throw new Error('recall: claim file missing id/subject');
  return { id, subject, status, confidence, derivedFrom, mentions, relatesTo, statement: body.trim() };
}

/** Extract `[[target]]` wikilink targets from a node body. */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

// ── The tool surface ────────────────────────────────────────────────────────────────────────

/** Build the read-only recall tool surface over a vault `root` (the evergreen checkout). */
export function makeReadOnlyTools(root: string): RecallTools {
  root = path.resolve(root);

  async function allEntities(): Promise<EntityHit[]> {
    const rels = await walkFiles(root, 'entities', (n) => n.endsWith('.md'));
    const hits: EntityHit[] = [];
    for (const rel of rels) {
      try {
        const p = await resolveContainedRel(root, rel);
        if (!p) continue;
        const node = parseEntityNode(await fs.readFile(p, 'utf8'));
        hits.push({
          rel,
          id: node.id,
          kind: node.kind,
          name: node.name,
          aliases: node.aliases,
          confidence: node.confidence,
          tags: node.tags,
          derivedFrom: node.derivedFrom,
        });
      } catch {
        /* foreign / malformed node — skip */
      }
    }
    return hits;
  }

  async function allClaims(): Promise<Array<ParsedClaim & { rel: string }>> {
    const rels = await walkFiles(root, 'claims', (n) => n.endsWith('.md'));
    const out: Array<ParsedClaim & { rel: string }> = [];
    for (const rel of rels) {
      try {
        const p = await resolveContainedRel(root, rel);
        if (!p) continue;
        out.push({ ...parseClaimMd(await fs.readFile(p, 'utf8')), rel });
      } catch {
        /* malformed claim — skip */
      }
    }
    return out;
  }

  /** Resolve an entity reference (rel path OR name/alias) to its node rel-path, or null. */
  async function resolveEntityRel(entity: string): Promise<string | null> {
    if (typeof entity !== 'string' || entity.length === 0) return null;
    const direct = await resolveContainedRel(root, entity);
    if (direct && entity.includes('/') && entity.endsWith('.md')) {
      try {
        await fs.access(direct);
        return entity;
      } catch {
        /* fall through to name match */
      }
    }
    const needle = entity.toLowerCase();
    const ents = await allEntities();
    const match =
      ents.find((e) => e.name.toLowerCase() === needle || e.aliases.some((a) => a.toLowerCase() === needle)) ??
      ents.find((e) => e.name.toLowerCase().includes(needle));
    return match ? match.rel : null;
  }

  return {
    async entityLookup({ query, kind, limit }): Promise<EntityHit[]> {
      const needle = (query ?? '').toLowerCase();
      const ents = await allEntities();
      return ents
        .filter((e) => (!kind || e.kind.toLowerCase() === kind.toLowerCase()))
        .filter(
          (e) =>
            needle.length === 0 ||
            e.name.toLowerCase().includes(needle) ||
            e.aliases.some((a) => a.toLowerCase().includes(needle)),
        )
        .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
        .slice(0, limit ?? DEFAULT_ENTITY_LIMIT);
    },

    async claimsForEntity({ entity, limit }): Promise<ClaimHit[]> {
      const rel = await resolveEntityRel(entity);
      if (!rel) return [];
      const claims = await allClaims();
      return claims
        .filter((c) => c.subject === rel)
        .slice(0, limit ?? DEFAULT_CLAIM_LIMIT)
        .map((c) => ({
          rel: c.rel,
          id: c.id,
          subject: c.subject,
          status: c.status,
          confidence: c.confidence,
          statement: c.statement,
          derivedFrom: c.derivedFrom,
          mentions: c.mentions,
          relatesTo: c.relatesTo,
        }));
    },

    async linkTraversal({ entity }): Promise<{ outgoing: LinkHit[]; incoming: LinkHit[] }> {
      const rel = await resolveEntityRel(entity);
      if (!rel) return { outgoing: [], incoming: [] };
      const outgoing: LinkHit[] = [];
      const p = await resolveContainedRel(root, rel);
      if (p) {
        try {
          for (const to of extractWikilinks(await fs.readFile(p, 'utf8'))) outgoing.push({ from: rel, to });
        } catch {
          /* unreadable node */
        }
      }
      // Incoming: any entity/claim file whose body links to this node by its rel path.
      const incoming: LinkHit[] = [];
      const candidates = [
        ...(await walkFiles(root, 'entities', (n) => n.endsWith('.md'))),
        ...(await walkFiles(root, 'claims', (n) => n.endsWith('.md'))),
      ];
      const target = `[[${rel}]]`;
      for (const fileRel of candidates) {
        if (fileRel === rel) continue;
        const fp = await resolveContainedRel(root, fileRel);
        if (!fp) continue;
        try {
          if ((await fs.readFile(fp, 'utf8')).includes(target)) incoming.push({ from: fileRel, to: rel });
        } catch {
          /* skip */
        }
      }
      return { outgoing, incoming };
    },

    async readNode({ rel }): Promise<string | null> {
      const p = await resolveContainedRel(root, rel);
      if (!p) return null;
      const r = typeof rel === 'string' ? rel : '';
      if (!(r.startsWith('entities/') || r.startsWith('entities' + path.sep) || r.startsWith('claims/') || r.startsWith('claims' + path.sep))) {
        return null; // read-only surface: only entity/claim docs via readNode
      }
      try {
        return await fs.readFile(p, 'utf8');
      } catch {
        return null;
      }
    },

    async readSource({ dir }): Promise<string | null> {
      if (typeof dir !== 'string' || dir.length === 0) return null;
      const rel = dir.endsWith('source.md') ? dir : path.join(dir, 'source.md');
      const p = await resolveContainedRel(root, rel);
      if (!p) return null;
      const r = path.relative(root, p);
      if (!(r === 'sources' || r.startsWith('sources/') || r.startsWith('sources' + path.sep))) return null;
      try {
        return await fs.readFile(p, 'utf8');
      } catch {
        return null;
      }
    },

    async grep({ pattern, limit }): Promise<GrepHit[]> {
      const needle = (pattern ?? '').toLowerCase();
      if (needle.length === 0) return [];
      const cap = limit ?? DEFAULT_GREP_LIMIT;
      const hits: GrepHit[] = [];
      const files = [
        ...(await walkFiles(root, 'sources', (n) => GREP_EXTS.has(path.extname(n)))),
        ...(await walkFiles(root, 'entities', (n) => GREP_EXTS.has(path.extname(n)))),
        ...(await walkFiles(root, 'claims', (n) => GREP_EXTS.has(path.extname(n)))),
      ];
      for (const rel of files) {
        if (hits.length >= cap) break;
        const p = await resolveContainedRel(root, rel);
        if (!p) continue;
        let text: string;
        try {
          text = await fs.readFile(p, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (lines[i].toLowerCase().includes(needle)) hits.push({ rel, line: i + 1, text: lines[i].trim() });
        }
      }
      return hits;
    },
  };
}
