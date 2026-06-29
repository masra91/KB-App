// Render a saved recall answer as a KB Output note (SPEC-0026 ASK-6 / DATA-4; F6 template ratified
// by KB-PM). Pure: given an AskResult + an id + timestamp, produce the markdown + its repo-relative
// path — so the format is node-tested without touching the fs/pipeline. The Output is **inert** (F2):
// it lives in `outputs/`, not `sources/`, and carries `generated: recall`, so the autonomous stages
// (which queue off `sources/`) never re-enrich it. Cited entities + claims render as `[[wikilinks]]`
// (ASK-14 — the saved-Output surface of the one canonical citation target, so the report threads back
// into the vault graph); a source is a directory, so it has no single note to link and renders as a
// path ref. Evidence lines are numbered `[n]` to match the answer's dense inline markers (DEV-3).
import type { AskResult, Citation } from './recall';
import { wikilinkTarget } from './citationLink';

/** The directory recall Outputs live in (repo-relative; under the evergreen `outputs/` tree). */
export const RECALL_OUTPUT_DIR = 'outputs/recall';

export interface BuiltOutput {
  /** Repo-relative path of the Output note, e.g. `outputs/recall/<id>.md`. */
  rel: string;
  /** The full markdown document. */
  markdown: string;
}

/** A concise, single-line title derived from the question (whitespace-collapsed, length-capped). */
function titleFromQuestion(question: string): string {
  const t = question.replace(/\s+/g, ' ').trim();
  if (t.length === 0) return 'Recall answer';
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
}

/** One numbered evidence line (ASK-13/14). The `[n]` matches the answer's inline marker. Entities +
 *  claims → `[[wikilink]]` (the shared canonical target); a source (a directory) → a path ref. */
function renderCitation(c: Citation, n: number): string {
  const target = wikilinkTarget(c.kind, c.ref, c.label);
  if (target !== null) {
    // For a claim the wikilink is the note basename, so keep the human label as a trailing note;
    // for an entity the label IS the link text, so there's nothing left to append.
    const tail = c.kind !== 'entity' && c.label && c.label.trim().length > 0 ? ` — ${c.label.trim()}` : '';
    return `- [${n}] [[${target}]]${tail}`;
  }
  const tail = c.label && c.label.trim().length > 0 ? ` — ${c.label.trim()}` : '';
  return `- [${n}] Source: \`${c.ref}\`${tail}`;
}

/**
 * Build the Output note for a saved recall answer (ASK-6). `id` is a ULID minted by the caller (the
 * filename + frontmatter id); `nowIso` is the save timestamp (injected for deterministic tests). The
 * whole-answer `grounded` flag drives the frontmatter + a header banner (F4 whole-answer labeling;
 * an ungrounded answer is allowed but prominently flagged). The answer's own inline `[n]` markers are
 * preserved as-is.
 */
export function buildRecallOutput(result: AskResult, id: string, nowIso: string): BuiltOutput {
  const title = titleFromQuestion(result.question);
  const banner = result.grounded
    ? `> Saved from a grounded recall on ${nowIso} — grounded against ${result.citations.length} citation${result.citations.length === 1 ? '' : 's'}.`
    : `> ⚠️ Not grounded — inferred. Saved from a recall on ${nowIso}; no verified library citations.`;
  const evidence =
    result.citations.length > 0 ? `\n\n## Evidence\n${result.citations.map((c, i) => renderCitation(c, i + 1)).join('\n')}` : '';

  const frontmatter = [
    '---',
    'type: output',
    'kind: recall-answer',
    `id: ${id}`,
    `created: ${nowIso}`,
    `question: ${JSON.stringify(result.question)}`,
    `grounded: ${result.grounded}`,
    'generated: recall',
    '---',
  ].join('\n');

  const markdown = `${frontmatter}\n\n# ${title}\n\n${banner}\n\n${result.answer.trim()}${evidence}\n`;
  return { rel: `${RECALL_OUTPUT_DIR}/${id}.md`, markdown };
}
