// Resolve an archived source's human title for the Status roster / current-item readout (PRIN-24) —
// so The Line, the Status stations, and the tray surface a *thing* (a title) and never a raw ULID.
// Main-process only: it reads `source.md` off disk, so it must run where the fs lives — in
// `computePipelineStatus` (OBS-24's background cadence, off the render path). The derivation itself is
// the ONE shared `deriveSourceTitle` (sourceDoc.ts / REVIEW-16) — never a second fallback ladder
// (Design-Lead's cross-surface rule: an untitled source must read identically everywhere).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dateShard, isUlid } from './ulid';
import { deriveSourceTitle } from './sourceDoc';

/** Human title for one source id: load `sources/<shard>/<id>/source.md` and derive (the shared
 *  `deriveSourceTitle`). Returns `undefined` for a non-ULID id (#29 — an entity / connect block key is
 *  not a source, so it maps to no source path) or a missing/unreadable source — the caller then leaves
 *  the name unresolved and the renderer guard shows the id (a non-ULID), never inventing a title. */
export async function readSourceTitle(root: string, id: string): Promise<string | undefined> {
  if (!isUlid(id)) return undefined; // not a source id — nothing to load (and never coerce one into a path)
  try {
    const p = path.join(path.resolve(root), 'sources', dateShard(id), id, 'source.md');
    return deriveSourceTitle(await fs.readFile(p, 'utf8'));
  } catch {
    return undefined; // missing/unreadable (e.g. mid-promotion) — leave unresolved, don't guess
  }
}

/** Resolve a batch of ids → a `{id → title}` map (only ULID sources that exist on disk appear). Dedups
 *  the ids so a source queued + processing isn't read twice, and reads concurrently (off the render
 *  path already, but the roster can be long). */
export async function readSourceTitles(
  root: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const title = await readSourceTitle(root, id);
      if (title !== undefined) out.set(id, title);
    }),
  );
  return out;
}
