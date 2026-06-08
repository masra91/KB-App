// Render a claim's `<ULID>.md` (SPEC-0016 §3.2) and maintain the entity node's generated
// claims block (§3.5, CLAIMS-9). Hand-rolled YAML (flat + one nested `provenance` block) —
// no yaml dependency (ENG-5), matching sourceDoc.ts / connectDoc.ts.
//
// Hybrid storage (CLAIMS-9): the claim FILE is canonical (full epistemics + provenance);
// the entity node additionally carries a clearly-delimited, regenerated block so its
// substance reads in place in Obsidian. The block is orchestrator-authored, regenerated
// WHOLE (idempotent), and is the ONLY part of the node Claims may touch — never the
// Decompose-authored identity frontmatter / heading (CLAIMS-11).
import type { ClaimDecision, ClaimStatus } from './claims';
import type { AgentTrace } from './archivist';

/** Quote a scalar only when it contains YAML-significant characters. */
function scalar(s: string): string {
  return /[:#'"\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** A YAML flow-sequence of quoted strings, e.g. `["a", "b"]`. */
function flowSeq(items: string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

/** Collapse a statement to a single trimmed line (for the YAML-free node block + commits). */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A truthful `transformedBy` from the decision's agent trace (ORCH-16). */
export function transformedByLabel(agent?: AgentTrace): string {
  if (agent?.via === 'copilot') return `claims · copilot (${agent.model ?? 'default'})`;
  return 'claims';
}

/**
 * A navigable Obsidian link to a claim's source (VAULT-13): `[[<dir>/source.md|<label>]]`, so a
 * human can **click through** to the source — not just read a provenance path. The display label
 * is the capture **date** parsed from the date-sharded provenance path (deterministic, no I/O, so
 * Replay-stable per VAULT-10); it falls back to the source-dir id when the path isn't date-sharded.
 * Returns '' for an empty/missing source. `derivedFrom` is the source DIRECTORY (e.g.
 * `sources/2026/05/30/<ULID>`); the readable note inside it is `source.md`.
 */
export function sourceLink(derivedFrom: string): string {
  const dir = derivedFrom.replace(/\/+$/, '');
  if (!dir) return '';
  const m = dir.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  // PRIN-24: NEVER surface a ULID as the link label. The date is the human label on the (normal)
  // date-sharded path; when the path isn't date-sharded, fall back to a neutral 'source' — the old
  // `dir.split('/').pop()` fallback leaked the source dir's ULID. (The date→source-TITLE display
  // upgrade — resolving the real title at render time — is REVIEW-17's title-resolver, not here.)
  const label = m ? `${m[1]}-${m[2]}-${m[3]}` : 'source';
  return `[[${dir}/source.md|${label}]]`;
}

export interface ClaimNodeMeta {
  id: string; // orchestrator-minted claim ULID
  subject: string; // repo-relative path to the subject entity node (CLAIMS-6/10)
  derivedFrom: string; // repo-relative path to the WHOLE source dir (provenance; CLAIMS-5)
  createdAt: string; // ISO timestamp
  agent?: AgentTrace;
}

/** Render one claim file: subject + epistemics (status/confidence) + evidence/provenance. */
export function renderClaimMd(claim: ClaimDecision, meta: ClaimNodeMeta): string {
  const fm: string[] = [
    `id: ${meta.id}`,
    `subject: ${scalar(meta.subject)}`,
    `status: ${claim.status}`,
    `confidence: ${claim.confidence}`,
    'provenance:',
    `  derivedFrom: ${flowSeq([meta.derivedFrom])}`,
    `  transformedBy: ${scalar(transformedByLabel(meta.agent))}`,
    `  mentions: ${flowSeq(claim.mentions)}`,
  ];
  // relatesTo: a soft, unresolved hint for Connect — emitted only when present (CLAIMS-10).
  if (claim.relatesTo && claim.relatesTo.length > 0) fm.push(`relatesTo: ${flowSeq(claim.relatesTo)}`);
  fm.push(`createdAt: ${meta.createdAt}`);
  // VAULT-13: a navigable source citation in the body, so the claim file clicks through to its
  // source rather than only carrying the path as provenance metadata.
  const src = sourceLink(meta.derivedFrom);
  const body = src ? `${oneLine(claim.statement)}\n\nSource: ${src}\n` : `${oneLine(claim.statement)}\n`;
  return `---\n${fm.join('\n')}\n---\n\n${body}`;
}

// ── The entity node's generated claims block (CLAIMS-9) ─────────────────────────────────

export const CLAIMS_BLOCK_START = '<!-- kb:claims:start (generated — edit claims/, not here) -->';
export const CLAIMS_BLOCK_END = '<!-- kb:claims:end -->';

/** One row in the entity node's generated block: a back-link to a canonical claim file. */
export interface ClaimBacklink {
  claimPath: string; // repo-relative path to the claim file (the [[wikilink]] target)
  statement: string;
  status: ClaimStatus;
  confidence: number;
  /** Source DIR for the claim's provenance (VAULT-13). When present, the row renders a navigable
   *  source citation. Optional so block regenerators that don't (yet) supply it still compile. */
  source?: string;
}

/** The generated block body (CLAIMS-9), regenerated WHOLE from the entity's claims. An entity
 *  with zero claims still gets a (placeholder) block so re-runs are idempotent (§3.6). Each row
 *  carries a navigable source citation when the backlink knows its source (VAULT-13). */
export function renderClaimsBlock(links: ClaimBacklink[]): string {
  const rows =
    links.length === 0
      ? ['_No claims derived yet._']
      : links.map((l) => {
          const cite = l.source ? ` · ${sourceLink(l.source)}` : '';
          return `- [[${l.claimPath}]] — ${oneLine(l.statement)} *(${l.status}, ${l.confidence})*${cite}`;
        });
  return [CLAIMS_BLOCK_START, ...rows, CLAIMS_BLOCK_END].join('\n');
}

/** Remove any existing generated claims block (and its surrounding blank lines) from a node. */
export function stripClaimsBlock(entityMd: string): string {
  const start = entityMd.indexOf(CLAIMS_BLOCK_START);
  if (start === -1) return entityMd;
  const endMarker = entityMd.indexOf(CLAIMS_BLOCK_END, start);
  const end = endMarker === -1 ? entityMd.length : endMarker + CLAIMS_BLOCK_END.length;
  return (entityMd.slice(0, start) + entityMd.slice(end)).replace(/\s+$/, '') + '\n';
}

/**
 * Idempotently (re)write the generated claims block in an entity node (CLAIMS-9). Strips any
 * prior block, then appends the freshly-regenerated one — so replays/re-pokes converge and
 * the identity frontmatter / `# Name` heading are never altered (CLAIMS-11).
 */
export function applyClaimsBlock(entityMd: string, links: ClaimBacklink[]): string {
  const base = stripClaimsBlock(entityMd).replace(/\s+$/, '');
  return `${base}\n\n${renderClaimsBlock(links)}\n`;
}
