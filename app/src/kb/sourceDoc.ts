// Render a source's `source.md` catalog card (SPEC-0013 §3): identity + classification +
// provenance in frontmatter, with the body carrying the text or embedding the raw file.
// Hand-rolled YAML (flat + one nested `provenance` block) — no yaml dependency (ENG-5).
import type { CapturedMeta } from './ingest';
import type { ArchiveDecision } from './archivist';

/** Quote a scalar only when it contains YAML-significant characters. */
function scalar(s: string): string {
  return /[:#'"\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** The Markdown body: text sources carry their content; files embed the raw payload. */
export function bodyFor(meta: CapturedMeta, textContent: string | null): string {
  return meta.kind === 'text' ? (textContent ?? '') : `![[${meta.raw}]]`;
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
    `sensitivity: ${decision.sensitivity}`,
    `raw: ${meta.raw}`,
    `contentHash: ${meta.contentHash}`,
  ];
  if (meta.originalName) fm.push(`originalName: ${scalar(meta.originalName)}`);
  if (meta.mimeType) fm.push(`mimeType: ${meta.mimeType}`);
  if (typeof meta.bytes === 'number') fm.push(`bytes: ${meta.bytes}`);
  fm.push(`capturedAt: ${meta.capturedAt}`);
  fm.push(`archivedAt: ${archivedAt}`);
  fm.push('provenance:');
  fm.push('  origin: principal');
  fm.push(`  surface: ${scalar(meta.surface)}`);
  fm.push(`  captureBatch: ${meta.captureBatch}`);
  fm.push(`  archivedBy: ${scalar('archivist (deterministic v1)')}`);
  return `---\n${fm.join('\n')}\n---\n\n${body}\n`;
}
