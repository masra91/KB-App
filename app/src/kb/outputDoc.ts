// Render a saved recall answer as a KB Output note (SPEC-0026 ASK-6 / DATA-4; F6 template ratified
// by KB-PM). Pure: given an AskResult + an id + timestamp, produce the markdown + its repo-relative
// path — so the format is node-tested without touching the fs/pipeline. The Output is **inert** (F2):
// it lives in `outputs/`, not `sources/`, and carries `generated: recall`, so the autonomous stages
// (which queue off `sources/`) never re-enrich it. Cited entities render as `[[wikilinks]]` so the
// saved report threads back into the graph (provenance); claims/sources render as path refs.
import path from 'node:path';
import type { AskResult, Citation } from './recall';

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

/** Last path segment without extension — the fallback wikilink target / display name. */
function baseName(rel: string): string {
  return path.basename(rel).replace(/\.md$/i, '');
}

/** One evidence line. Entities → `[[wikilink]]` (threads into the graph); claims/sources → path ref. */
function renderCitation(c: Citation): string {
  if (c.kind === 'entity') {
    const name = c.label && c.label.trim().length > 0 ? c.label.trim() : baseName(c.ref);
    return `- [[${name}]]`;
  }
  const tail = c.label && c.label.trim().length > 0 ? ` — ${c.label.trim()}` : '';
  const noun = c.kind === 'claim' ? 'Claim' : 'Source';
  return `- ${noun}: \`${c.ref}\`${tail}`;
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
    : `> ⚠️ Not grounded — inferred. Saved from a recall on ${nowIso}; no verified KB citations.`;
  const evidence = result.citations.length > 0 ? `\n\n## Evidence\n${result.citations.map(renderCitation).join('\n')}` : '';

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
