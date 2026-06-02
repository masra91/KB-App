// Funnel conversion counts (SPEC-0032 VIZ §9 / VIZ-3) — the cumulative "captured → candidates →
// entities → claims → promoted" tallies the VIZ gauge-rail overlay needs. Derived from CURRENT vault
// STATE (count what exists now), NOT from audit-event tallies — so retries/replays don't inflate it
// (a re-derived entity is still one entity). Raw counts only; the frontend computes the between-bucket
// deltas + the dedup/fan-out ratios (VIZ-3, the directional caption). Best-effort: a missing dir → 0,
// never throws (read-only diagnostics, like the rest of the OBS view-model).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findEntityFiles } from './claimsStage';
import type { ConversionCounts } from './pipelineStatusView';

export type { ConversionCounts };

/** Recursively count files under `dir` matching `pred` (best-effort: missing/unreadable dir → 0). */
async function countFiles(dir: string, pred: (name: string) => boolean): Promise<number> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(path.join(dir, e.name), pred);
    else if (e.isFile() && pred(e.name)) n += 1;
  }
  return n;
}

const isSourceMd = (name: string): boolean => name === 'source.md'; // one per source dir
const isJson = (name: string): boolean => name.endsWith('.json');
const isMd = (name: string): boolean => name.endsWith('.md');

/**
 * Read the current-state funnel counts (VIZ-3). `stagingRoot` is the working pipeline worktree (where
 * sources/candidates/entities/claims live); `mainRoot` is the published vault (where `promoted` is
 * counted — sources that reached `main`). Counts run concurrently; each is independently best-effort.
 */
export async function readConversionCounts(stagingRoot: string, mainRoot: string): Promise<ConversionCounts> {
  const s = path.resolve(stagingRoot);
  const m = path.resolve(mainRoot);
  const [captured, candidates, entities, claims, promoted] = await Promise.all([
    countFiles(path.join(s, 'sources'), isSourceMd),
    countFiles(path.join(s, 'candidates'), isJson),
    findEntityFiles(s).then((f) => f.length).catch(() => 0),
    countFiles(path.join(s, 'claims'), isMd),
    countFiles(path.join(m, 'sources'), isSourceMd),
  ]);
  return { captured, candidates, entities, claims, promoted };
}
