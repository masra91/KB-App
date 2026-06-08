// Render a source's `source.md` catalog card (SPEC-0013 §3): identity + classification +
// provenance in frontmatter, with the body carrying the text or embedding the raw file.
// Hand-rolled YAML (flat + one nested `provenance` block) — no yaml dependency (ENG-5).
import type { CapturedMeta } from './ingest';
import type { ArchiveDecision, AgentTrace } from './archivist';

/** Quote a scalar only when it contains YAML-significant characters. */
function scalar(s: string): string {
  return /[:#'"\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** A truthful `archivedBy` from the decision's agent trace (ORCH-16). */
export function archivedByLabel(agent?: AgentTrace): string {
  if (agent?.via === 'copilot') return `copilot (${agent.model ?? 'default'})`;
  if (agent?.runtime === 'copilot') return `deterministic (copilot failed: ${agent.error ?? 'unknown'})`;
  if (agent?.error) return `deterministic (${agent.error})`; // e.g. copilot unavailable
  return 'deterministic';
}

/** The Markdown body: text sources carry their content; files embed the raw payload. */
export function bodyFor(meta: CapturedMeta, textContent: string | null): string {
  return meta.kind === 'text' ? (textContent ?? '') : `![[${meta.raw}]]`;
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
  const block = `sensitivity: ${scalar(label)}\nsensitivityMeta:\n  by: principal\n  at: ${at}`;
  return withoutMeta.replace(/^sensitivity: .*$/m, block);
}

export function renderSourceMd(
  meta: CapturedMeta,
  decision: ArchiveDecision,
  archivedAt: string,
  body: string,
): string {
  const fm: string[] = [
    `id: ${meta.id}`,
    `class: ${decision.class}`,
    `kind: ${decision.kind}`,
    `scope: ${decision.scope}`,
    `sensitivity: ${scalar(decision.sensitivity)}`,
    // SENSE-1/8 (SPEC-0043 §7): the label's provenance lives beside it so the scalar stays clean for the
    // comparator + human reading. Slice 1 records `by` + `at`; `confidence` (by: classifier) and
    // `suggested` (open Review suggestion) arrive in Slice 2.
    'sensitivityMeta:',
    `  by: ${decision.sensitivityBy}`,
    `  at: ${decision.sensitivityAt ?? archivedAt}`, // override time (sticky on Replay) else archive time
    `raw: ${meta.raw}`,
    `contentHash: ${meta.contentHash}`,
  ];
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
  return `---\n${fm.join('\n')}\n---\n\n${body}\n`;
}
