// Citation render targets (SPEC-0026 ASK-14) — one canonical citation `ref` → two surfaces:
//  - the Ask panel: a deep-link into Obsidian via the `obsidian://open` URI (opened with
//    `shell.openExternal` in the main process; no CLI dependency, ASK-9 stays optional);
//  - a saved Output: a native `[[wikilink]]` (handled in outputDoc.ts).
// This module owns the pure string transforms so both are tested without electron/DOM.
import path from 'node:path';

/**
 * The Obsidian deep-link for an **absolute** vault file path (ASK-14). `path` is percent-encoded so
 * spaces / `#` / `?` / non-ASCII in the path can't break the URI or smuggle query params. The caller
 * (main process) resolves the citation's vault-relative `ref` to an absolute path first and is
 * responsible for containment (the path must stay within the vault).
 */
export function obsidianOpenUri(absPath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absPath)}`;
}

/**
 * The native `[[wikilink]]` target for a citation `ref` (ASK-14, saved-Output surface). Entities and
 * claims resolve by their note basename (Obsidian resolves `[[Name]]` across the vault); a `source`
 * `ref` is a directory (no single note), so it has no wikilink — callers render it as a path ref.
 * Returns null when there's no sensible wikilink target.
 */
export function wikilinkTarget(kind: 'entity' | 'claim' | 'source', ref: string, label?: string): string | null {
  if (kind === 'source') return null; // a source is a dir, not a linkable note
  const name = label && label.trim().length > 0 && kind === 'entity' ? label.trim() : path.basename(ref).replace(/\.md$/i, '');
  return name.length > 0 ? name : null;
}
