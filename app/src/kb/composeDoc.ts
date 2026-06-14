// composeDoc (SPEC-0046) — render a grounded ComposeDecision into the entity's encyclopedic prose
// body, and the idempotent surgery that (re)writes ONLY the prose region of an entity node. Pure:
// no I/O. The STAGE resolves the cited claims + their source titles and hands them in.
//
// Body layout (SPEC-0046 §2):
//   ---<identity frontmatter>---
//   # <Name>
//   <PROSE — lede + ## sections + inline [^n] citations + ## References>   ← Compose owns this region
//   <!-- kb:links:start … -->  …  <!-- kb:links:end -->                    ← Connect's block, KEPT below
//   <!-- kb:claims:start … --> …  <!-- kb:claims:end -->                   ← Claims' block, KEPT below
//
// The prose region is everything between the `# <Name>` H1 and the FIRST structured-block marker;
// it carries NO delimiter of its own (the Principal wants it to read like Wikipedia, not a machine
// block), so we locate it structurally and regenerate it WHOLE — idempotent like the other blocks.
import { LINKS_BLOCK_START } from './connectDoc';
import { CLAIMS_BLOCK_START } from './claimDoc';
import type { ComposeDecision, CitedClaim } from './compose';

/**
 * Render a grounded decision + its cited claims into the prose body (lede + sections + References).
 * Pure. Citations are **source-level**, numbered in order of first appearance (Wikipedia style):
 * a sentence's claim indices map to their source dirs, deduped to footnote numbers; the References
 * section lists each cited source ONCE, by human title, as a navigable wikilink (COMPOSE-2/8). The
 * `[^n]` markers are emitted HERE (never by the agent), so every inline citation traces to a real
 * source.
 */
export function renderProse(decision: ComposeDecision, claims: readonly CitedClaim[]): string {
  const sourceToNum = new Map<string, number>();
  const references: { n: number; sourceRel: string; title: string }[] = [];

  // Map a sentence's 1-based claim indices → its sorted, deduped source-footnote numbers, assigning
  // a new footnote the first time a source is cited (so numbering follows reading order).
  const footnotesFor = (claimIdxs: readonly number[]): number[] => {
    const nums: number[] = [];
    for (const idx of claimIdxs) {
      const claim = claims[idx - 1];
      if (!claim) continue; // out-of-range is rejected upstream (validateGrounding) — stay defensive
      let n = sourceToNum.get(claim.sourceRel);
      if (n === undefined) {
        n = references.length + 1;
        sourceToNum.set(claim.sourceRel, n);
        references.push({ n, sourceRel: claim.sourceRel, title: claim.title });
      }
      if (!nums.includes(n)) nums.push(n);
    }
    return nums.sort((a, b) => a - b);
  };

  const blocks: string[] = [];
  for (const section of decision.sections) {
    // Drop a spurious agent-authored "References" section — Compose owns References (built below).
    if (section.heading && /^references$/i.test(section.heading)) continue;
    const lines: string[] = [];
    if (section.heading) lines.push(`## ${section.heading}`);
    const sentences = section.sentences
      .map((s) => {
        const marks = footnotesFor(s.claims)
          .map((n) => `[^${n}]`)
          .join('');
        return `${s.text.trim()}${marks}`;
      })
      .filter((s) => s.length > 0);
    if (sentences.length > 0) lines.push(sentences.join(' '));
    if (lines.length > 0) blocks.push(lines.join('\n'));
  }

  if (references.length > 0) {
    const refLines = references.map((r) => `[^${r.n}]: [[${r.sourceRel}/source.md|${r.title}]]`);
    blocks.push(['## References', ...refLines].join('\n'));
  }

  return blocks.join('\n\n').trim();
}

/** The structured-block boundary: the earliest of the links/claims markers (COMPOSE-5 keeps those
 *  blocks BELOW the prose). Returns md.length when the node has no structured blocks yet. */
function firstBlockIndex(md: string): number {
  const idxs = [md.indexOf(LINKS_BLOCK_START), md.indexOf(CLAIMS_BLOCK_START)].filter((i) => i >= 0);
  return idxs.length ? Math.min(...idxs) : md.length;
}

/** Index just past the entity's `# <Name>` H1 line (where the prose region begins). Falls back to
 *  the end of the frontmatter, then to 0, on a malformed node (ENG-16: degrade, never crash). */
function proseStart(md: string): number {
  const h1 = md.match(/^# .*$/m);
  if (h1 && h1.index !== undefined) {
    const nl = md.indexOf('\n', h1.index);
    return nl === -1 ? md.length : nl + 1;
  }
  if (md.startsWith('---')) {
    const fmEnd = md.indexOf('\n---', 3);
    if (fmEnd !== -1) {
      const nl = md.indexOf('\n', fmEnd + 1);
      return nl === -1 ? md.length : nl + 1;
    }
  }
  return 0;
}

/**
 * Idempotently (re)write the entity's prose region — everything between the `# <Name>` H1 and the
 * first structured block. Keeps the identity frontmatter + H1 above and the kb:links / kb:claims
 * blocks BELOW untouched (COMPOSE-5). Passing an empty body strips the prose (the deterministic
 * fallback, or a claim-less entity). Re-applying the same body is byte-stable (idempotent).
 */
export function applyProse(entityMd: string, proseBody: string): string {
  const start = proseStart(entityMd);
  const blockAt = firstBlockIndex(entityMd);
  const head = entityMd.slice(0, start).replace(/\s+$/, '');
  // Keep the blocks verbatim. Guard the (malformed) case where a marker precedes the H1.
  const blocks = (blockAt >= start ? entityMd.slice(blockAt) : '').replace(/^\s+/, '').replace(/\s+$/, '');
  const prose = proseBody.trim();
  let out = head;
  if (prose) out += `\n\n${prose}`;
  if (blocks) out += `\n\n${blocks}`;
  return `${out}\n`;
}

/** Strip the prose region back to just the structured blocks (the deterministic fallback —
 *  Compose-unavailable leaves the page as today's blocks-only node, never a hard failure). */
export function stripProse(entityMd: string): string {
  return applyProse(entityMd, '');
}

/** Whether a node already carries a prose region between its H1 and its first structured block
 *  (non-whitespace). Lets the stage detect "already composed" for idempotent re-pokes. */
export function hasProse(entityMd: string): boolean {
  const start = proseStart(entityMd);
  const blockAt = firstBlockIndex(entityMd);
  if (blockAt < start) return false;
  return entityMd.slice(start, blockAt).trim().length > 0;
}

/**
 * SPEC-0051 COHERE-1 — resolve BARE woven `[[Name]]` links in the entity's PROSE region to path form
 * `[[entities/kind/Name.md|Name]]` via the caller's `resolve(name) → rel | null`. Compose weaves links
 * as bare display names (composeAgent), which Obsidian can't resolve to the kind-subdir entity path, so
 * they render dead (`[[Harrie]]`). Only the prose region is touched — the frontmatter/H1 above and the
 * kb:links / kb:claims blocks below are left verbatim (COMPOSE-5). A link is rewritten ONLY when it is
 * bare (no `|`, no `/`) AND `resolve` returns exactly one entity rel; unknown/ambiguous targets are
 * left bare (CONNECT-13 — never a dangling guess). Idempotent: a rewritten `[[rel|Name]]` carries a `|`
 * so a later pass skips it. ENG-16: a malformed `[[...]]` or a throwing resolver leaves the link as-is,
 * never corrupts the doc.
 */
export function resolveProseWikilinks(entityMd: string, resolve: (name: string) => string | null): string {
  const start = proseStart(entityMd);
  const end = firstBlockIndex(entityMd);
  if (end <= start) return entityMd; // no prose region to touch
  const prose = entityMd.slice(start, end);
  const rewritten = prose.replace(/\[\[([^\]]+)\]\]/g, (whole: string, inner: string) => {
    if (inner.includes('|') || inner.includes('/')) return whole; // already piped or path form — leave
    const name = inner.trim();
    if (!name) return whole;
    let rel: string | null = null;
    try {
      rel = resolve(name);
    } catch {
      return whole; // ENG-16: a resolver throw never corrupts the doc
    }
    return rel ? `[[${rel}|${name}]]` : whole; // unknown/ambiguous → leave bare (CONNECT-13)
  });
  return entityMd.slice(0, start) + rewritten + entityMd.slice(end);
}
