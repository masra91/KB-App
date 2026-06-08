// SENSE Principal-override store (SPEC-0043 SENSE-7): the Principal's explicit sensitivity labels, kept
// in `.kb/sensitivity/overrides.json` — TRACKED (the vault gitignore ignores only `.kb/cache/`), so it
// survives a full Replay and is present in every archive worktree. The archiver re-applies an override
// over the decider's decision on EVERY archive (incl. a rebuild), which is what makes a Principal label
// **sticky across Replay** and guarantees the classifier **never overwrites** a `by: principal` label (D4).
//
// The map is keyed by the artifact's id (a source ULID or an entity slug) — used only as a JSON key here,
// never built into a filesystem path (the IPC that edits the artifact validates the id resolves to a real
// source before touching disk).
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** One Principal override: the chosen label + when it was set (provenance for `sensitivityMeta.at`). */
export interface SensitivityOverride {
  label: string;
  at: string;
}

/** targetId (source/entity id) → the Principal's override. */
export type SensitivityOverrides = Record<string, SensitivityOverride>;

const REL = path.join('.kb', 'sensitivity', 'overrides.json');

/** Absolute path to a vault's sensitivity-override store. */
export function sensitivityOverridesPath(root: string): string {
  return path.join(path.resolve(root), REL);
}

/** Read the override store. Missing/malformed → empty (no overrides). Each entry is validated — a row
 *  without a non-empty string `label` is dropped, so a hand-/foreign-edited file can't inject a bad label. */
export async function readSensitivityOverrides(root: string): Promise<SensitivityOverrides> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(sensitivityOverridesPath(root), 'utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: SensitivityOverrides = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const label = (v as Record<string, unknown>).label;
      const at = (v as Record<string, unknown>).at;
      if (typeof label === 'string' && label.trim().length > 0) {
        out[k] = { label, at: typeof at === 'string' ? at : '' };
      }
    }
  }
  return out;
}

/** Write the store deterministically under `.kb/sensitivity/`. */
export async function writeSensitivityOverrides(root: string, overrides: SensitivityOverrides): Promise<void> {
  const p = sensitivityOverridesPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
}

/** Upsert one Principal override (or clear it when `label` is empty) and return the updated map. */
export async function setSensitivityOverride(root: string, targetId: string, label: string, at: string): Promise<SensitivityOverrides> {
  const overrides = await readSensitivityOverrides(root);
  if (label.trim().length === 0) delete overrides[targetId];
  else overrides[targetId] = { label, at };
  await writeSensitivityOverrides(root, overrides);
  return overrides;
}
