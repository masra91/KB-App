// Working-zone-aware source location (SPEC-0018 REVIEW-17 / PRIN-24). A disambiguation review can be
// raised MID-PIPELINE, so the source it references may be **staging-only** — written to the staging
// worktree but **not yet promoted to `main`** (the user's Obsidian vault, where `obsidian://open`
// resolves). Opening such a source in Obsidian is "file not found". So before firing a deep link we
// must resolve WHERE the source's `source.md` actually lives RIGHT NOW:
//   - on `main`        → openable in Obsidian (the evergreen vault has it);
//   - staging-only     → not in the vault yet → the caller shows an in-app / "still processing" state;
//   - nowhere          → genuinely missing (deleted / bad ref).
// Pure resolution + containment only (no electron, no shell) so it unit-tests on real temp dirs.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveContainedRel } from './pathContainment';

/**
 * Where a source ref resolves at this instant:
 * - `main`    — exists in the evergreen vault → open in Obsidian (caller fires `obsidian://`).
 * - `staging` — exists only in the staging worktree (raised before promotion) → caller falls back to
 *               an in-app source view / "still processing — will be in your vault shortly" (REVIEW-17).
 * - `missing` — not found in either zone (deleted, or a stale/bad ref) → no open, no dead link.
 * - `invalid` — the ref isn't a usable contained relative path (empty / traversal / symlink escape).
 */
export type SourceLocation = 'main' | 'staging' | 'missing' | 'invalid';

export interface LocatedSource {
  location: SourceLocation;
  /** The absolute path under `main` (lexically resolved, containment-verified) — set ONLY for `main`,
   *  the path the caller hands to `obsidianOpenUri`. Never set for the other locations. */
  mainAbs?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a repo-relative source ref (e.g. `sources/<shard>/<id>/source.md`) to its current zone.
 * `mainRoot` is the evergreen vault (the Obsidian vault); `stagingRoot` is the staging worktree (or
 * null when no pipeline is active). The ref is untrusted (it flows from a persisted review whose
 * `sourceRel` the stage built), so BOTH lookups go through `resolveContainedRel` — a traversal/escape
 * in either zone yields `invalid`, never an fs touch outside the zone. `main` wins over `staging`
 * (once promoted, prefer the vault the user actually sees).
 */
export async function locateSourceRef(
  mainRoot: string,
  stagingRoot: string | null,
  ref: string,
): Promise<LocatedSource> {
  if (typeof ref !== 'string' || ref.trim().length === 0) return { location: 'invalid' };

  const mainAbs = await resolveContainedRel(path.resolve(mainRoot), ref);
  if (mainAbs === null) return { location: 'invalid' }; // escaped containment
  if (await pathExists(mainAbs)) return { location: 'main', mainAbs };

  if (stagingRoot) {
    const stagingAbs = await resolveContainedRel(path.resolve(stagingRoot), ref);
    // A containment escape under staging is `invalid` too (don't silently downgrade to `missing`).
    if (stagingAbs === null) return { location: 'invalid' };
    if (await pathExists(stagingAbs)) return { location: 'staging' };
  }

  return { location: 'missing' };
}
