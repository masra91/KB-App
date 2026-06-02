// Per-Instance config (SPEC-0027 PANEL-5 / AUTO-12) — Instance-wide settings the Control Panel's
// Settings view owns. Stored at `.kb/instance.json` (per-vault, like the job registry — NOT the
// app-global appConfig; an Instance default is a property of a KB). It lives under `.kb/` (tracked
// on `staging`, never promoted, hidden from Obsidian on `main`), so it's git-auditable but invisible
// to the vault. Deliberately kept OUT of the core VaultConfig / SPEC-0007 data model.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AUTONOMY_POSTURES, DEFAULT_POSTURE, type AutonomyPosture } from './jobs';

const INSTANCE_REL = path.join('.kb', 'instance.json');

/** Instance-wide settings (PANEL-5). v1 holds the autonomy default; grows as Settings does. */
export interface InstanceConfig {
  /** The Instance-wide default autonomy posture (AUTO-12). Jobs inherit it unless they override. */
  autonomyDefault: AutonomyPosture;
}

/** Absolute path to a vault's instance-config file. */
export function instanceConfigPath(root: string): string {
  return path.join(path.resolve(root), INSTANCE_REL);
}

/** The safe default Instance config (Guarded — the conservative autonomy posture, AUTO-12). */
export function defaultInstanceConfig(): InstanceConfig {
  return { autonomyDefault: DEFAULT_POSTURE };
}

/** Read the Instance config (PANEL-5). Missing/malformed file or unknown posture → safe defaults. */
export async function readInstanceConfig(root: string): Promise<InstanceConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(instanceConfigPath(root), 'utf8');
  } catch {
    return defaultInstanceConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultInstanceConfig();
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const autonomyDefault = (AUTONOMY_POSTURES as readonly string[]).includes(o.autonomyDefault as string)
    ? (o.autonomyDefault as AutonomyPosture)
    : DEFAULT_POSTURE;
  return { autonomyDefault };
}

/** Write the Instance config (Settings edit, PANEL-5/6) — deterministic, stable key order. */
export async function writeInstanceConfig(root: string, cfg: InstanceConfig): Promise<void> {
  const p = instanceConfigPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Resolve a job's effective autonomy posture (AUTO-12 cascade) — **the single swap point** if the
 * Principal's per-Instance-posture ruling lands differently (only this function changes; the
 * `.kb/instance.json` storage + the Settings UI stay). Working cascade: an **explicit per-job
 * posture wins**; otherwise the job **inherits the Instance default**.
 */
export function resolveJobPosture(instanceDefault: AutonomyPosture, jobPosture: AutonomyPosture | undefined): AutonomyPosture {
  return jobPosture ?? instanceDefault;
}
