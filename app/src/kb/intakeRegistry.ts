// The intake connector registry (SPEC-0041 INTAKE-4) — per-vault config the Principal owns, the
// parallel sibling of the researcher + job registries. Stored at `.kb/intake/registry.json`: tracked
// on `staging` (the vault gitignore ignores only `.kb/cache/`), never promoted (not in
// EVERGREEN_PATHS) — git-auditable but hidden from Obsidian on `main`. Control-Panel edits go through
// these helpers.
//
// Mirrors jobRegistry/researcherRegistry's #29 path-injection hardening: validate the untrusted,
// hand-/foreign-editable `id` at EVERY boundary (read + write + patch) via `isSafeConnectorId`,
// surfacing rejects on the injectable devlog, never silent — a `.kb/intake/<id>/` ledger path can
// never be fed a traversal id downstream. A connector id need not equal its type: the Principal may
// register several RSS connectors (different feeds), so the only id rule is the bare-slug guard.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEDULE_PRESETS, type SchedulePreset } from './jobs';
import {
  INTAKE_CONNECTOR_TYPES,
  DEFAULT_INTAKE_SCOPE,
  DEFAULT_INTAKE_SENSITIVITY,
  isSafeConnectorId,
  type IntakeConnectorConfig,
  type IntakeConnectorType,
} from './intakeConnectors';
import { noopDevLog, type DevLog } from './devlog';

const REGISTRY_REL = path.join('.kb', 'intake', 'registry.json');

/** Absolute path to a vault's intake connector registry file. */
export function intakeRegistryPath(root: string): string {
  return path.join(path.resolve(root), REGISTRY_REL);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate one stored row into an IntakeConnectorConfig, or null to skip a malformed one (never
 *  crash a read). Unknown type/schedule fall back to conservative defaults (`off` schedule). */
function validConnector(v: unknown): IntakeConnectorConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.id)) return null;
  if (!(INTAKE_CONNECTOR_TYPES as readonly string[]).includes(o.type as string)) return null;
  const type = o.type as IntakeConnectorType;
  const schedule: SchedulePreset = (SCHEDULE_PRESETS as readonly string[]).includes(o.schedule as string)
    ? (o.schedule as SchedulePreset)
    : 'off';
  const c: IntakeConnectorConfig = {
    id: o.id,
    type,
    schedule,
    enabled: o.enabled === true,
    scope: isNonEmptyString(o.scope) ? o.scope : DEFAULT_INTAKE_SCOPE,
    sensitivity: isNonEmptyString(o.sensitivity) ? o.sensitivity : DEFAULT_INTAKE_SENSITIVITY,
  };
  if (isNonEmptyString(o.label)) c.label = o.label;
  if (typeof o.maxItemsPerPass === 'number' && o.maxItemsPerPass > 0 && Number.isFinite(o.maxItemsPerPass)) {
    c.maxItemsPerPass = Math.floor(o.maxItemsPerPass);
  }
  if (o.config && typeof o.config === 'object') c.config = o.config as Record<string, unknown>;
  return c;
}

/**
 * Read the vault's intake connector registry. Missing/malformed file → empty (no connectors). A row
 * whose `id` is not a bare slug is DROPPED at this read boundary (path-injection guard, #29-class)
 * and surfaced on `devlog` (never silent). Valid rows still load.
 */
export async function readIntakeRegistry(root: string, devlog: DevLog = noopDevLog): Promise<IntakeConnectorConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(intakeRegistryPath(root), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: IntakeConnectorConfig[] = [];
  for (const row of parsed) {
    const c = validConnector(row);
    if (!c) continue;
    if (!isSafeConnectorId(c.id)) {
      devlog.warn('intake-id-rejected', { intakeId: c.id, source: 'registry-read', reason: 'id is not a bare slug (path-traversal guard, INTAKE/#29)' });
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Write the registry deterministically under `.kb/intake/`. */
export async function writeIntakeRegistry(root: string, connectors: IntakeConnectorConfig[]): Promise<void> {
  const p = intakeRegistryPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(connectors, null, 2) + '\n', 'utf8');
}

/** Insert or replace a connector by `id`, returning the updated registry. Rejects an unsafe `id` at
 *  the write boundary (throw — never persist) so a traversal id can't enter the registry. */
export async function upsertIntakeConnector(root: string, connector: IntakeConnectorConfig): Promise<IntakeConnectorConfig[]> {
  if (!isSafeConnectorId(connector.id)) {
    throw new Error(`refusing to register intake connector with unsafe id: ${JSON.stringify(connector.id)}`);
  }
  const connectors = await readIntakeRegistry(root);
  const idx = connectors.findIndex((c) => c.id === connector.id);
  if (idx === -1) connectors.push(connector);
  else connectors[idx] = connector;
  await writeIntakeRegistry(root, connectors);
  return connectors;
}

/**
 * Delete one intake connector by `id` from the registry (PANEL-11 lifecycle delete), returning the
 * updated registry. PURGES the config row only — already-produced sources/findings + the audit trail
 * are NOT touched here (ground truth is sacred; the caller audits the removal). No-op (returns the list
 * unchanged) if the id is absent. Rejects an unsafe `id` at the boundary (fail loud at the write seam).
 */
export async function deleteIntakeConnector(root: string, id: string): Promise<IntakeConnectorConfig[]> {
  if (!isSafeConnectorId(id)) throw new Error(`refusing to delete intake connector with unsafe id: ${JSON.stringify(id)}`);
  const connectors = await readIntakeRegistry(root);
  const remaining = connectors.filter((c) => c.id !== id);
  if (remaining.length !== connectors.length) await writeIntakeRegistry(root, remaining);
  return remaining;
}

/** Patch one connector's mutable fields; no-op if absent. Rejects an unsafe `id` at the boundary. */
export async function patchIntakeConnector(
  root: string,
  id: string,
  patch: Partial<Pick<IntakeConnectorConfig, 'enabled' | 'schedule' | 'scope' | 'sensitivity' | 'label' | 'maxItemsPerPass' | 'config'>>,
): Promise<IntakeConnectorConfig[]> {
  if (!isSafeConnectorId(id)) throw new Error(`refusing to patch intake connector with unsafe id: ${JSON.stringify(id)}`);
  const connectors = await readIntakeRegistry(root);
  const c = connectors.find((x) => x.id === id);
  if (c) {
    if (patch.enabled !== undefined) c.enabled = patch.enabled;
    if (patch.schedule !== undefined) c.schedule = patch.schedule;
    if (patch.scope !== undefined) c.scope = patch.scope;
    if (patch.sensitivity !== undefined) c.sensitivity = patch.sensitivity;
    if (patch.label !== undefined) c.label = patch.label;
    if (patch.maxItemsPerPass !== undefined) c.maxItemsPerPass = patch.maxItemsPerPass;
    if (patch.config !== undefined) c.config = patch.config;
    await writeIntakeRegistry(root, connectors);
  }
  return connectors;
}
