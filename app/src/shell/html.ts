// Tiny DOM/string helpers shared by the renderer and shell views.

/**
 * Escape a string for safe interpolation into innerHTML. NULL-SAFE (ENG-16): a renderer formats
 * pipeline-/agent-produced data whose optional/derived fields can be null/undefined on legacy or
 * partial records (e.g. a Review candidate with `title: null`, raised before title-persistence). A
 * raw `.replace` on such a value threw inside a `.map` and blanked an ENTIRE list ("Loading…
 * forever") — so every shared format helper must tolerate null/undefined (→ '') and coerce any
 * non-string (→ String) rather than throw. Callers may still prefer a meaningful fallback upstream.
 */
export function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Last path segment of a folder path, with a friendly fallback. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'My KB';
}
