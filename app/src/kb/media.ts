// Tiny extension → media-type lookup + raw-filename helper for captured payloads.
// Deliberately small and in-house (ENG-5) — just enough to label common kinds; unknown
// types fall back to octet-stream. Richer typing/extraction is Enrich's job, not capture.
import path from 'node:path';

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
};

/** Best-effort media type from a filename's extension. */
export function mimeForName(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** The in-unit raw filename for a dropped file: `raw<.ext>` (sanitized), else `raw.bin`. */
export function rawNameFor(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return ext.length > 1 ? `raw${ext}` : 'raw.bin';
}
