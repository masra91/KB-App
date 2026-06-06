// Rich Ingestion (SPEC-0040 RICHIN) — capture-time text→Markdown normalization.
// Pure + shell-agnostic (no electron/DOM-env assumptions): turndown bundles its own DOM
// (@mixmark-io/domino) so this runs in the renderer AND in node-env tests. This is the ONLY
// new capture-time transform RICHIN introduces; the preservation/archive spine is untouched
// (RICHIN-9). HTML parsing is delegated to a pinned, reputable library — never hand-rolled
// (E1) — because correct/safe HTML handling is a security + correctness surface.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/** A turndown service tuned for *semantic structure, not visual chrome* (RICHIN-1):
 *  ATX headings, fenced code, `-` bullets, `*` emphasis; GFM gives tables + strikethrough +
 *  task lists. Non-content nodes (script/style/head/…) are dropped entirely. */
function makeService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
    linkStyle: 'inlined',
  });
  td.use(gfm);
  // Drop visual-only / non-content nodes — they carry no knowledge (RICHIN-1).
  td.remove(['script', 'style', 'head', 'meta', 'link', 'noscript', 'title']);
  return td;
}

/**
 * Convert clipboard/HTML markup to Markdown, preserving semantic block + inline structure
 * (headings, lists, blockquotes, code, tables, links, images-by-reference, emphasis) and
 * dropping visual styling (RICHIN-1). Returns trimmed Markdown.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  return makeService().turndown(html).trim();
}

/** The clipboard flavors a paste can carry (the bits we read off `DataTransfer`). */
export interface ClipboardFlavors {
  html?: string | null;
  plain?: string | null;
}

/** How a paste was interpreted. `rich` ⇒ structure was preserved and the original markup
 *  should be kept verbatim as a sidecar (RICHIN-2); else it's an ordinary plain-text paste. */
export interface PasteInterpretation {
  /** The text to capture as the payload (`raw.md`): derived Markdown for a rich paste, else plain. */
  markdown: string;
  /** The original clipboard HTML to preserve verbatim as `original.html`; null for a plain paste. */
  html: string | null;
  rich: boolean;
}

/**
 * Decide whether a paste is rich (convert HTML→Markdown, keep the original as a sidecar) or
 * plain (RICHIN-1/2/3). The sidecar is kept ONLY when an HTML flavor exists AND actually adds
 * structure over the plain text (RICHIN-2 "only when it differs"). `plainOnly` forces the
 * plain path — the "paste as plain text" escape hatch (RICHIN-3).
 */
export function interpretPaste(flavors: ClipboardFlavors, opts: { plainOnly?: boolean } = {}): PasteInterpretation {
  const plain = (flavors.plain ?? '').replace(/\r\n/g, '\n');
  const html = flavors.html ?? '';
  if (opts.plainOnly || !html.trim()) return { markdown: plain, html: null, rich: false };

  const md = htmlToMarkdown(html);
  // No structure gained (markup collapses to the same text) ⇒ treat as plain, no empty sidecar.
  if (!md || md === plain.trim()) return { markdown: plain || md, html: null, rich: false };
  return { markdown: md, html, rich: true };
}
