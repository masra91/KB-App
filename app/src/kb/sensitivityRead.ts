// SENSE read surface (SPEC-0043 SENSE-10): read a source's current sensitivity label + provenance from
// its `source.md` frontmatter, for the Control Panel to display (and offer the Principal an edit). Kept
// SENSE-owned + read-only so the consumer (the Activity-lineage drill-down) doesn't ripple SPEC-0029's
// Lineage type. Mirrors the override IPC's frontmatter parse — the `sensitivity:` scalar is the current
// label (post-override), `sensitivityMeta.by` its origin.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dateShard, isUlid } from './ulid';
import type { SensitivityBy } from './sensitivity';

/** A source's displayable sensitivity (SENSE-10). `null` from the reader when the source can't be read. */
export interface SourceSensitivity {
  sensitivity: string;
  by: SensitivityBy | string;
}

/** Parse the `sensitivity:` scalar + `sensitivityMeta.by` out of a `source.md` frontmatter body. */
export function parseSensitivityFromSourceMd(content: string): SourceSensitivity | null {
  const label = content.match(/^sensitivity: (.*)$/m)?.[1]?.trim();
  if (label === undefined) return null;
  // strip surrounding YAML double-quotes if the writer quoted a YAML-significant label
  const unquoted = label.startsWith('"') && label.endsWith('"') ? JSON.parse(label) : label;
  const by = content.match(/^ {2}by: (.*)$/m)?.[1]?.trim() ?? 'default';
  return { sensitivity: unquoted, by };
}

/** Read one archived source's sensitivity from `sources/<shard>/<id>/source.md`. Returns null on a bad id
 *  (#29 — only a real ULID maps to a source path) or a missing/unreadable source. */
export async function readSourceSensitivity(root: string, sourceId: string): Promise<SourceSensitivity | null> {
  if (!isUlid(sourceId)) return null;
  const p = path.join(path.resolve(root), 'sources', dateShard(sourceId), sourceId, 'source.md');
  try {
    return parseSensitivityFromSourceMd(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Batch read (one call per lineage render). Returns a map id → sensitivity; absent/unreadable ids are
 *  simply omitted (the view degrades to no chip for them). */
export async function readSourceSensitivities(root: string, sourceIds: readonly string[]): Promise<Record<string, SourceSensitivity>> {
  const out: Record<string, SourceSensitivity> = {};
  await Promise.all(
    [...new Set(sourceIds)].map(async (id) => {
      const s = await readSourceSensitivity(root, id);
      if (s) out[id] = s;
    }),
  );
  return out;
}
