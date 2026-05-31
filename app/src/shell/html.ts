// Tiny DOM/string helpers shared by the renderer and shell views.

/** Escape a string for safe interpolation into innerHTML. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Last path segment of a folder path, with a friendly fallback. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'My KB';
}
