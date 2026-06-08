// The researcher registry (SPEC-0028 RESEARCH-1/15) — per-vault config the Principal owns, the
// parallel sibling of the job registry. Stored at `.kb/researchers/registry.json`: tracked on
// `staging` (the vault gitignore ignores only `.kb/cache/`), never promoted (not in EVERGREEN_PATHS)
// — git-auditable but hidden from Obsidian on `main`. Control-Panel edits go through these helpers.
//
// Mirrors jobRegistry's #29 path-injection hardening (validate the untrusted, hand-/foreign-editable
// `id` at EVERY boundary — read + write + patch — via `isSafeResearcherId`, surfacing rejects on the
// injectable devlog, never silent). UNLIKE jobs, a researcher id need NOT equal its template: the
// Principal may register several researchers of the same template (e.g. two Web researchers scoped to
// different topics), so the only id rule is the bare-slug guard.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEDULE_PRESETS, AUTONOMY_POSTURES, DEFAULT_POSTURE, type SchedulePreset, type AutonomyPosture } from './jobs';
import {
  EGRESS_TIERS,
  RESEARCHER_TEMPLATES,
  DEFAULT_RESEARCHER_BUDGET,
  isSafeResearcherId,
  type ResearcherConfig,
  type EgressTier,
  type ResearcherTemplate,
  type ResearcherBudget,
} from './researchers';
import { noopDevLog, type DevLog } from './devlog';

const REGISTRY_REL = path.join('.kb', 'researchers', 'registry.json');

/** Absolute path to a vault's researcher registry file. */
export function researcherRegistryPath(root: string): string {
  return path.join(path.resolve(root), REGISTRY_REL);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Coerce a stored budget into a valid ResearcherBudget, falling back to the safe default per field. */
function validBudget(v: unknown): ResearcherBudget {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const pos = (n: unknown, fallback: number): number => (typeof n === 'number' && n > 0 && Number.isFinite(n) ? n : fallback);
  return {
    maxToolCalls: pos(o.maxToolCalls, DEFAULT_RESEARCHER_BUDGET.maxToolCalls),
    maxDepth: pos(o.maxDepth, DEFAULT_RESEARCHER_BUDGET.maxDepth),
  };
}

/** Validate one stored row into a ResearcherConfig, or null to skip a malformed one (never crash a
 *  read). Unknown template/egress/schedule/posture fall back to conservative defaults. */
function validResearcher(v: unknown): ResearcherConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.id) || !isNonEmptyString(o.prompt)) return null;
  const template: ResearcherTemplate = (RESEARCHER_TEMPLATES as readonly string[]).includes(o.template as string)
    ? (o.template as ResearcherTemplate)
    : 'custom';
  const egressTier: EgressTier = (EGRESS_TIERS as readonly string[]).includes(o.egressTier as string)
    ? (o.egressTier as EgressTier)
    : 'local-only'; // unknown → most-restrictive destination (no external egress) is the safe default
  const schedule: SchedulePreset = (SCHEDULE_PRESETS as readonly string[]).includes(o.schedule as string)
    ? (o.schedule as SchedulePreset)
    : 'off';
  const posture: AutonomyPosture = (AUTONOMY_POSTURES as readonly string[]).includes(o.posture as string)
    ? (o.posture as AutonomyPosture)
    : DEFAULT_POSTURE;
  const r: ResearcherConfig = {
    id: o.id,
    template,
    prompt: o.prompt,
    egressTier,
    scope: isNonEmptyString(o.scope) ? o.scope : 'global',
    budget: validBudget(o.budget),
    schedule,
    posture,
    enabled: o.enabled === true,
  };
  if (isNonEmptyString(o.label)) r.label = o.label;
  // Carry the editable per-pass session timeout through the read (RESEARCH-18, WS3). Without this the
  // persisted `timeoutMs` patchResearcher writes is dropped on the very next read → a user's edited
  // timeout silently reverts to the default. Preserve a valid positive number; garbage falls away and
  // `resolveTimeoutMs` supplies the default (and re-clamps on use). (maxToolCalls rides `budget`, which
  // validBudget already preserves — timeoutMs is the top-level field that was being lost.)
  if (typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) r.timeoutMs = o.timeoutMs;
  // Carry the editable orient budget through the read too (RESEARCH-22, warm-start) — same persist-on-read
  // guard as timeoutMs (#245 class): a valid positive number survives; garbage falls away and
  // `resolveOrientBudget` supplies the default.
  if (typeof o.orientBudget === 'number' && Number.isFinite(o.orientBudget) && o.orientBudget > 0) r.orientBudget = o.orientBudget;
  if (Array.isArray(o.topics)) r.topics = o.topics.filter(isNonEmptyString);
  if (Array.isArray(o.allowedTools)) r.allowedTools = o.allowedTools.filter(isNonEmptyString);
  if (o.config && typeof o.config === 'object') r.config = o.config as Record<string, unknown>;
  return r;
}

/**
 * Read the vault's researcher registry. Missing/malformed file → empty (no researchers). A row whose
 * `id` is not a bare slug is DROPPED at this read boundary (path-injection guard, #29-class) and
 * surfaced on `devlog` (never silent) — a `.kb/researchers/<id>/` journal/worktree path can never be
 * fed a traversal id downstream. Valid rows still load.
 */
export async function readResearcherRegistry(root: string, devlog: DevLog = noopDevLog): Promise<ResearcherConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(researcherRegistryPath(root), 'utf8');
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
  const out: ResearcherConfig[] = [];
  for (const row of parsed) {
    const r = validResearcher(row);
    if (!r) continue;
    if (!isSafeResearcherId(r.id)) {
      devlog.warn('researcher-id-rejected', { researcherId: r.id, source: 'registry-read', reason: 'id is not a bare slug (path-traversal guard, RESEARCH/#29)' });
      continue;
    }
    out.push(r);
  }
  return out;
}

/** Write the registry deterministically under `.kb/researchers/`. */
export async function writeResearcherRegistry(root: string, researchers: ResearcherConfig[]): Promise<void> {
  const p = researcherRegistryPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(researchers, null, 2) + '\n', 'utf8');
}

/** Insert or replace a researcher by `id`, returning the updated registry. Rejects an unsafe `id`
 *  at the write boundary (throw — never persist) so a traversal id can't enter the registry. Unlike
 *  jobs, multiple researchers per template are allowed, so there is no `id === template` rule. */
export async function upsertResearcher(root: string, researcher: ResearcherConfig): Promise<ResearcherConfig[]> {
  if (!isSafeResearcherId(researcher.id)) {
    throw new Error(`refusing to register researcher with unsafe id: ${JSON.stringify(researcher.id)}`);
  }
  const researchers = await readResearcherRegistry(root);
  const idx = researchers.findIndex((r) => r.id === researcher.id);
  if (idx === -1) researchers.push(researcher);
  else researchers[idx] = researcher;
  await writeResearcherRegistry(root, researchers);
  return researchers;
}

/** Patch one researcher's mutable fields; no-op if absent. Rejects an unsafe `id` at the boundary. */
export async function patchResearcher(
  root: string,
  id: string,
  patch: Partial<Pick<ResearcherConfig, 'enabled' | 'schedule' | 'posture' | 'prompt' | 'egressTier' | 'scope' | 'budget' | 'timeoutMs' | 'orientBudget' | 'topics' | 'allowedTools' | 'config'>>,
): Promise<ResearcherConfig[]> {
  if (!isSafeResearcherId(id)) throw new Error(`refusing to patch researcher with unsafe id: ${JSON.stringify(id)}`);
  const researchers = await readResearcherRegistry(root);
  const r = researchers.find((x) => x.id === id);
  if (r) {
    if (patch.enabled !== undefined) r.enabled = patch.enabled;
    if (patch.schedule !== undefined) r.schedule = patch.schedule;
    if (patch.posture !== undefined) r.posture = patch.posture;
    if (patch.prompt !== undefined) r.prompt = patch.prompt;
    if (patch.egressTier !== undefined) r.egressTier = patch.egressTier;
    if (patch.scope !== undefined) r.scope = patch.scope;
    if (patch.budget !== undefined) r.budget = patch.budget;
    if (patch.timeoutMs !== undefined) r.timeoutMs = patch.timeoutMs;
    if (patch.orientBudget !== undefined) r.orientBudget = patch.orientBudget;
    if (patch.topics !== undefined) r.topics = patch.topics;
    if (patch.allowedTools !== undefined) r.allowedTools = patch.allowedTools;
    if (patch.config !== undefined) r.config = patch.config;
    await writeResearcherRegistry(root, researchers);
  }
  return researchers;
}
