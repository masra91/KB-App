// Render a source's `source.md` catalog card (SPEC-0013 §3): identity + classification +
// provenance in frontmatter, with the body carrying the text or embedding the raw file.
// Hand-rolled YAML (flat + one nested `provenance` block) — no yaml dependency (ENG-5).
import type { CapturedMeta } from './ingest';
import type { ArchiveDecision, AgentTrace } from './archivist';

/** Quote a scalar only when it contains YAML-significant characters. */
function scalar(s: string): string {
  return /[:#'"\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** The neutral generic a titleless source falls back to — NEVER a raw ULID (PRIN-24). Exported so the
 *  renderer-safe status guard (`pipelineStatusLabels.displayItemName`) reuses the SAME wording: an
 *  untitled source reads identically in Reviews, the Status stations, The Line, and the tray. */
export const UNTITLED_SOURCE = 'Untitled source';

/**
 * The human-title derivation ladder from STRUCTURED parts (no md parsing): the file's `originalName`
 * → the first body heading / non-empty line → a neutral generic. NEVER a ULID. Shared by the
 * write-path (`renderSourceMd`, which persists the result as `title:`) and the read-path
 * (`deriveSourceTitle`), so a titleless source resolves to the SAME string everywhere (PRIN-24, one
 * wording — PR #285/#295 lineage). Truncated so a long first line can't blow out a review row.
 */
export function pickSourceTitle(originalName: string | undefined, body: string): string {
  if (originalName && originalName.trim()) return clipTitle(originalName.trim());
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+[ \t]*/, '').trim(); // strip a leading markdown heading marker
    if (t) return clipTitle(t);
  }
  return UNTITLED_SOURCE;
}

/**
 * A human-readable title for a source, read from its `source.md`. Precedence: a persisted (or
 * Principal-overridden) frontmatter **`title:`** wins (the stored human label / future override);
 * else derive via the shared `pickSourceTitle` ladder (originalName → first body line → generic).
 * NEVER returns a raw ULID — a source surfaced to the Principal must read as a *thing*, not an id
 * (PRIN-24 / REVIEW-16). Pure (no FS) — callers read the file and pass content.
 */
export function deriveSourceTitle(sourceMd: string): string {
  const fmMatch = sourceMd.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : '';
  // PRIN-24: the persisted `title:` (written at ingest, or a future Principal override) is the source
  // of truth — it wins over re-derivation so the human label is stable + overridable.
  const stored = fm.match(/^title:[ \t]*(.+)$/m);
  if (stored) {
    const v = decodeScalar(stored[1]);
    if (v.trim()) return clipTitle(v.trim());
  }
  const on = fm.match(/^originalName:[ \t]*(.+)$/m);
  const body = sourceMd.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return pickSourceTitle(on ? decodeScalar(on[1]) : undefined, body);
}

function clipTitle(s: string): string {
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

/** Decode a `scalar()`-encoded frontmatter value (JSON-quoted only when it carried special chars). */
function decodeScalar(v: string): string {
  const t = v.trim();
  return t.startsWith('"') ? safeJsonParse(t) ?? t : t;
}

function safeJsonParse(s: string): string | null {
  try {
    const v = JSON.parse(s);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** A truthful `archivedBy` from the decision's agent trace (ORCH-16). */
export function archivedByLabel(agent?: AgentTrace): string {
  if (agent?.via === 'copilot') return `copilot (${agent.model ?? 'default'})`;
  if (agent?.runtime === 'copilot') return `deterministic (copilot failed: ${agent.error ?? 'unknown'})`;
  if (agent?.error) return `deterministic (${agent.error})`; // e.g. copilot unavailable
  return 'deterministic';
}

/**
 * The Markdown body: text sources carry their content; file sources embed the raw payload — and, when
 * media extraction produced a text body (SPEC-0052 MEDIA), weave that extracted text in BELOW the embed.
 * The raw embed is ALWAYS kept for a file source (MEDIA-4: the original binary stays viewable + replay-
 * safe); the extracted text is purely additive so decompose/claims see real content (a PDF/image is no
 * longer a dead `![[raw.pdf]]`). No extracted text (plain file, or extraction failed/absent) → embed-only,
 * the unchanged behavior.
 */
export function bodyFor(meta: CapturedMeta, textContent: string | null): string {
  if (meta.kind === 'text') return textContent ?? '';
  const embed = `![[${meta.raw}]]`;
  const extracted = textContent?.trim();
  return extracted ? `${embed}\n\n${extracted}` : embed;
}

/**
 * Re-stamp a `source.md`'s sensitivity to a Principal override (SENSE-7): replace the `sensitivity:`
 * scalar and reset its `sensitivityMeta` block to `by: principal` + the override `at` (clearing any
 * `confidence`/`suggested` — D: an override clears the suggestion). Robust to a source archived BEFORE
 * SENSE landed (no `sensitivityMeta` block yet): the block is injected fresh. Returns the rewritten doc.
 */
export function applySensitivityOverrideToSourceMd(content: string, label: string, at: string): string {
  // Drop any existing sensitivityMeta block (header + its indented children, however many).
  const withoutMeta = content.replace(/^sensitivityMeta:\n(?: {2}\S.*\n)*/m, '');
  // Replace the sensitivity scalar line, appending a fresh principal provenance block right after it.
  // NB: a FUNCTION replacer (not a string) — a label containing `$&`/`$1`/`` $` `` must not trigger JS's
  // replacement-pattern substitution and corrupt the frontmatter (KB-QD-2 #267).
  const block = `sensitivity: ${scalar(label)}\nsensitivityMeta:\n  by: principal\n  at: ${at}`;
  return withoutMeta.replace(/^sensitivity: .*$/m, () => block);
}

export function renderSourceMd(
  meta: CapturedMeta,
  decision: ArchiveDecision,
  archivedAt: string,
  body: string,
): string {
  // PRIN-24: persist a human title as a frontmatter Property so the source is self-describing IN
  // Obsidian (the file's Properties panel), not just in the app's read-time derivation — the
  // Principal's "god help us Obsidian" is about opening the file, which a read-time derivation never
  // touches. Same `pickSourceTitle` ladder deriveSourceTitle uses (one wording); never a ULID.
  // Writing it once at ingest is metadata-at-creation, not a body mutation (PRIN-1 safe).
  const title = pickSourceTitle(meta.originalName, body);
  const fm: string[] = [
    `id: ${meta.id}`,
    `title: ${scalar(title)}`,
    `class: ${decision.class}`,
    `kind: ${decision.kind}`,
    `scope: ${decision.scope}`,
    `sensitivity: ${scalar(decision.sensitivity)}`,
    // SENSE-1/8 (SPEC-0043 §7): the label's provenance lives beside it so the scalar stays clean for the
    // comparator + human reading. `by` + `at` always; `confidence` rides a `by: classifier` label (SENSE-4),
    // and `suggested` rides while a sub-threshold Review suggestion is open (cleared by a Principal override).
    'sensitivityMeta:',
    `  by: ${decision.sensitivityBy}`,
    `  at: ${decision.sensitivityAt ?? archivedAt}`, // override time (sticky on Replay) else archive time
  ];
  if (typeof decision.sensitivityConfidence === 'number') fm.push(`  confidence: ${decision.sensitivityConfidence}`);
  if (decision.sensitivitySuggested) fm.push(`  suggested: ${scalar(decision.sensitivitySuggested)}`);
  fm.push(`raw: ${meta.raw}`);
  fm.push(`contentHash: ${meta.contentHash}`);
  // RICHIN-10: capture-fidelity provenance for a derived text payload — how `raw.md` was
  // produced (html→md) and the verbatim original kept alongside it. Auditable + re-derivable.
  if (meta.clip) {
    fm.push('clip:');
    fm.push(`  format: ${scalar(meta.clip.format)}`);
    fm.push(`  original: ${scalar(meta.clip.original)}`);
  }
  if (meta.originalName) fm.push(`originalName: ${scalar(meta.originalName)}`);
  if (meta.mimeType) fm.push(`mimeType: ${meta.mimeType}`);
  if (typeof meta.bytes === 'number') fm.push(`bytes: ${meta.bytes}`);
  fm.push(`capturedAt: ${meta.capturedAt}`);
  fm.push(`archivedAt: ${archivedAt}`);
  fm.push('provenance:');
  fm.push(`  origin: ${meta.origin ?? 'principal'}`);
  fm.push(`  surface: ${scalar(meta.surface)}`);
  fm.push(`  captureBatch: ${meta.captureBatch}`);
  fm.push(`  archivedBy: ${scalar(archivedByLabel(decision.agent))}`);
  // Citation-rich research provenance on a secondary source (SPEC-0028 RESEARCH-6): which
  // researcher, the request answered, the outbound query, and the external sources it cites.
  if (meta.research) {
    const r = meta.research;
    fm.push('  research:');
    fm.push(`    researcherId: ${scalar(r.researcherId)}`);
    fm.push(`    requestId: ${scalar(r.requestId)}`);
    fm.push(`    query: ${scalar(r.query)}`);
    fm.push(`    fetchedAt: ${r.fetchedAt}`);
    fm.push('    citations:');
    for (const c of r.citations) fm.push(`      - ${scalar(c)}`);
  }
  // PRIN-24: surface the title as an H1 for FILE sources — the body is an opaque `![[raw]]` embed, so a
  // heading is pure chrome (the raw file is untouched) and the title (= originalName) is DISTINCT from
  // the embed, so it never duplicates. NOT for text (its body is the Principal's verbatim capture —
  // PRIN-1 forbids injecting a heading) and NOT for research (its title derives FROM the finding's own
  // first line, so an H1 would duplicate it — the persisted `title:` Property carries it instead).
  const surfacedBody = meta.kind === 'file' ? `# ${title}\n\n${body}` : body;
  return `---\n${fm.join('\n')}\n---\n\n${surfacedBody}\n`;
}
