// Shared fs-path containment (SPEC-0030 / #30 sweep) — the ONE place that decides whether an
// LLM-/external-derived RELATIVE path may hit an fs read/write/delete sink. It exists because that
// decision was re-derived per sink and kept slipping (the path-injection family: #52, #61/#73, #77);
// every fs sink that takes an untrusted `rel` routes through here so containment is defined once.
//
// CLASS A — rel-containment (this module): a relative path resolved under a `root` MUST stay within
// it, and (optionally) under an allowlisted top-level subtree. SYMLINK-SAFE: the deepest existing
// ancestor is realpath'd, so a committed symlink (e.g. `entities/x -> ../../sources`) can't appear
// contained and then be followed out — lexical `path.resolve` alone misses this. The symlink-safe
// resolution is lifted verbatim from #61's proven `resolveSymlinkSafe` (jobStage write-sink guard).
//
// CLASS B — id-validation (e.g. `isSafeJobId`): a value used as a path SEGMENT / key, validated by
// charset (no separators / traversal). It is DISTINCT from Class A and this module does NOT replace
// it (and it does not replace this): segment-injection ≠ path traversal. Do not conflate or
// "simplify" one into the other — a write/delete sink that takes both an id and a rel needs both.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ContainmentOk {
  ok: true;
  /** The lexical `path.resolve(root, rel)` — the path the caller uses; containment was verified on
   *  the symlink-resolved real path, so reading/writing this lexical path is safe. */
  abs: string;
}
export interface ContainmentErr {
  ok: false;
  /** `escape` = leaves the root (traversal/absolute/symlink-escape); `not-allowed` = inside the root
   *  but outside the allowlisted subtrees. Lets a caller map to its own message (behavior-identical). */
  kind: 'escape' | 'not-allowed';
  reason: string;
}
export type ContainmentResult = ContainmentOk | ContainmentErr;

/** Thrown by {@link assertContainedRel} when a rel escapes its root or its allowed subtree(s). */
export class ContainmentError extends Error {
  constructor(
    readonly kind: 'escape' | 'not-allowed',
    message: string,
  ) {
    super(message);
    this.name = 'ContainmentError';
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Realpath the deepest EXISTING ancestor of `target` and re-append the non-existent tail, so a
 *  symlink anywhere in the existing portion is resolved even when `target` itself does not exist yet.
 *  (Lifted from #61's jobStage `resolveSymlinkSafe` — the reference behavior for the sweep.) */
async function resolveSymlinkSafe(target: string): Promise<string> {
  let existing = target;
  const tail: string[] = [];
  while (!(await pathExists(existing))) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) return target; // hit the fs root without an existing ancestor
    existing = parent;
  }
  const realBase = await fs.realpath(existing);
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

/**
 * Symlink-safe containment for a relative path under `root` (Class A). The resolved REAL path must
 * stay strictly within `root`'s real path; when `allowed` is non-empty, its top-level segment must
 * be one of those subtrees. Catches `..` traversal, absolute paths, `a/../../b` escapes, and
 * committed-symlink escapes. Returns the **lexical** abs (the caller's path) on success, or a typed
 * rejection (`kind` lets the caller keep its own message). `root` must be an existing directory.
 */
export async function checkContainedRel(root: string, rel: string, allowed: readonly string[] = []): Promise<ContainmentResult> {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { ok: false, kind: 'escape', reason: 'empty path' };
  }
  const lexical = path.resolve(root, rel);
  const rootReal = await fs.realpath(root);
  const resolvedReal = await resolveSymlinkSafe(lexical);
  if (resolvedReal === rootReal || !resolvedReal.startsWith(rootReal + path.sep)) {
    return { ok: false, kind: 'escape', reason: `path escapes the root: ${rel}` };
  }
  if (allowed.length > 0) {
    const top = path.relative(rootReal, resolvedReal).split(path.sep)[0];
    if (!allowed.includes(top)) {
      return { ok: false, kind: 'not-allowed', reason: `path outside the allowed roots (${allowed.join('/')}): ${rel}` };
    }
  }
  return { ok: true, abs: lexical };
}

/** Skip-on-escape ergonomic (READS): the contained abs path, or `null` so the caller skips it —
 *  reads never throw (preserves recallTools' null-skip). Symlink-safe like the others (SPEC-0030). */
export async function resolveContainedRel(root: string, rel: string, allowed: readonly string[] = []): Promise<string | null> {
  const r = await checkContainedRel(root, rel, allowed);
  return r.ok ? r.abs : null;
}

/** Throwing ergonomic (WRITES/DELETES): the contained abs path, or throws {@link ContainmentError}.
 *  For sinks that must abort on a violation (e.g. the Reflect/Connect merge sink). */
export async function assertContainedRel(root: string, rel: string, allowed: readonly string[] = []): Promise<string> {
  const r = await checkContainedRel(root, rel, allowed);
  if ('reason' in r) throw new ContainmentError(r.kind, r.reason);
  return r.abs;
}
