// Control Panel · Researchers — pure view-model logic (SPEC-0028 RESEARCH-15). DOM-free +
// side-effect-free (SHELL-6 / TEST-5): the main process gathers the fs-backed inputs (registry +
// last-run audit events) and hands them here; the renderer renders the result. Mirrors jobsPanel.
import { EGRESS_TIERS, RESEARCHER_TEMPLATES, TEMPLATE_DEFAULT_EGRESS, DEFAULT_RESEARCHER_BUDGET, resolveTimeoutMs, resolveOrientBudget, type ResearcherConfig, type EgressTier, type ResearcherTemplate } from './researchers';
import { DEFAULT_POSTURE } from './jobs';
import { schedulePresetLabel, SCHEDULE_OPTIONS } from './jobsPanel';
import type { AuditEvent, AuditEventInput } from './audit';
import type { ResearcherView, ResearcherLastRun, ResearcherConfigPatch } from './types';

export { schedulePresetLabel, SCHEDULE_OPTIONS };

/** An add-from-template option for the Researchers view (RESEARCH-15/16). Slice 1 ships Web; Code +
 *  M365 are present as options but their behaviors land in Slices 2/3 (the view can still register
 *  the config). `custom` is the bare generic core. */
export interface ResearcherTemplateOption {
  template: ResearcherTemplate;
  label: string;
  description: string;
  defaultEgress: EgressTier;
}

export const RESEARCHER_TEMPLATE_OPTIONS: ResearcherTemplateOption[] = [
  { template: 'web', label: 'Public Web', description: 'Public-web search & fetch — prior art, press releases, definitions.', defaultEgress: 'public-web' },
  { template: 'code', label: 'Local Repository', description: 'Local repos + GitHub/Azure DevOps reads (read-only). Slices 2.', defaultEgress: 'local-only' },
  { template: 'm365', label: 'WorkIQ/M365', description: 'Mail/calendar/SharePoint/Teams via your tenant (OAuth). Slice 3.', defaultEgress: 'internal-tenant' },
  { template: 'custom', label: 'Custom', description: 'Your own prompt + MCP/tools + declared egress tier.', defaultEgress: 'local-only' },
];

/** Human labels for the egress tiers (RESEARCH-8), least→most exposed. */
export const EGRESS_TIER_LABELS: Record<EgressTier, string> = {
  'local-only': 'Local only',
  'internal-tenant': 'Internal tenant',
  'public-web': 'Public web',
};

/** Longer one-line gloss for an egress tier — used as a `title`/tooltip so the dropdown option text
 *  stays short (#108) while the full meaning is still a hover away. */
export const EGRESS_TIER_HINTS: Record<EgressTier, string> = {
  'local-only': 'Never leaves this machine',
  'internal-tenant': 'Your org / tenant (e.g. WorkIQ, M365)',
  'public-web': 'The public internet',
};

/** Egress exposure rank (higher = data can reach a less-trusted destination). Widening egress to a
 *  higher rank is a risky change (more KB content can leave) → confirm + audit. */
const EGRESS_EXPOSURE: Record<EgressTier, number> = { 'local-only': 0, 'internal-tenant': 1, 'public-web': 2 };

/** The researcher run-outcome audit kinds (the `eventType`s `runResearcher`/`researchEscalate` emit). */
export type ResearchOutcomeKind = 'researched' | 'no-finding' | 'research-failed' | 'ceiling-reached' | 'escalated';

/**
 * Principal-facing labels for every researcher run-outcome kind. The audit kinds are dev slugs; a user
 * surface must never show the raw slug (KB product principle). This is a TOTAL `Record` over the union,
 * so adding a new `ResearchOutcomeKind` is a COMPILE error until it's labeled here — the no-slug
 * guarantee fails at build, never in the UI (KB-QD #180). The "Field Desk" redesign (#65) renders these
 * as the typed report; until then they keep the last-run line jargon-free.
 */
const RESEARCH_OUTCOME_LABELS: Record<ResearchOutcomeKind, string> = {
  researched: 'found sources',
  'no-finding': 'no new findings',
  'research-failed': 'run failed',
  'ceiling-reached': 'paused — rate limit reached',
  escalated: 'paused — needs your review',
};

/**
 * Map a run-outcome `eventType` to its Principal-facing label. Known kinds get the curated label
 * (compiler-enforced complete above); an UNKNOWN kind (e.g. a future audit slug not yet mapped) is
 * humanized — kebab → spaced words — so even then the UI never shows a raw dev slug.
 */
export function researcherOutcomeLabel(eventType: string): string {
  if (Object.prototype.hasOwnProperty.call(RESEARCH_OUTCOME_LABELS, eventType)) {
    return RESEARCH_OUTCOME_LABELS[eventType as ResearchOutcomeKind];
  }
  return eventType.replace(/-/g, ' '); // never leak kebab-case
}

/** Derive a researcher's last-run summary from its newest `researcher` audit event (or null). */
export function lastRunFromEvent(event: AuditEvent | undefined): ResearcherLastRun | null {
  if (!event) return null;
  const p = event.payload;
  const citations = Array.isArray(p.citations) ? p.citations.length : 0;
  return {
    ts: event.ts,
    eventType: event.eventType,
    what: typeof p.what === 'string' ? p.what : '',
    ...(event.subjects.sourceId ? { sourceId: event.subjects.sourceId } : {}),
    ...(event.subjects.reviewId ? { reviewId: event.subjects.reviewId } : {}), // depth-escalation Review (RESEARCH-11)
    citations,
  };
}

/**
 * Map the researcher registry into display rows (RESEARCH-15), overlaying each researcher's last-run
 * from `lastEventByResearcherId`. Unlike jobs there is no pre-registered catalog of rows — researchers
 * are all Principal-created from templates (RESEARCHER_TEMPLATE_OPTIONS is the add list, not rows).
 * Rows in registry order.
 */
export function buildResearcherViews(
  registry: ResearcherConfig[],
  lastEventByResearcherId: Record<string, AuditEvent | undefined>,
): ResearcherView[] {
  return registry.map((r) => ({
    id: r.id,
    template: r.template,
    // WS1 #6: fall back to the researcher's real name (id), NEVER the generic template word — the strip
    // shows the id, and the run-now confirm + outbound query read this label; `?? r.template` made both
    // say "code"/"web" instead of the researcher's name. The id is the slugified name the Principal gave it.
    label: r.label ?? r.id,
    prompt: r.prompt,
    repoPath: typeof r.config?.repoPath === 'string' ? r.config.repoPath : '',
    tenantId: typeof r.config?.tenantId === 'string' ? r.config.tenantId : '',
    prRepo: typeof r.config?.prRepo === 'string' ? r.config.prRepo : '',
    egressTier: r.egressTier,
    scope: r.scope,
    enabled: r.enabled,
    schedule: r.schedule,
    posture: r.posture,
    topics: r.topics ?? [],
    budget: { maxToolCalls: r.budget.maxToolCalls, maxDepth: r.budget.maxDepth },
    timeoutMs: resolveTimeoutMs(r), // RESEARCH-18: persisted value or the default (WS3 editable)
    orientBudget: resolveOrientBudget(r), // RESEARCH-22: persisted value or the default (warm-start editable)
    allowedTools: r.allowedTools ?? [],
    lastRun: lastRunFromEvent(lastEventByResearcherId[r.id]),
  }));
}

/**
 * Honest run-eligibility for a researcher (WS1 #2). The ENABLED switch — NOT the schedule — is the true
 * run/don't-run gate: the inline dispatcher (`runInlineResearch`) runs EVERY *enabled* researcher on
 * pending `research-request`s REGARDLESS of schedule, while the scheduler (`isResearcherDue`) only adds a
 * standing cadence for enabled + scheduled researchers. So an enabled researcher with schedule `off` is
 * NOT paused — it still runs on demand when your KB raises a question (which is why a "schedule: Off"
 * researcher legitimately shows a recent last run). Only a disabled researcher truly won't run. This
 * derives the honest one-line surface so "Off" can't masquerade as "won't run".
 */
export function researcherRunEligibility(r: Pick<ResearcherView, 'enabled' | 'schedule'>): { willRun: boolean; note: string } {
  if (!r.enabled) return { willRun: false, note: "Paused — won't run until enabled" };
  if (r.schedule === 'off') return { willRun: true, note: 'Runs on demand (no schedule)' };
  return { willRun: true, note: `Runs ${schedulePresetLabel(r.schedule).toLowerCase()} + on demand` };
}

/**
 * WORKIQ-UI — the m365 connector install/status card's pure presentation logic (DOM-free; the renderer
 * assembles HTML from this). The card state is broader than the IPC `WorkIqStatus`: it adds the two
 * renderer-owned TRANSIENT states shown while an IPC call is in flight (`checking`, `installing`) plus
 * `install-failed` (a failed `installWorkIq`). The tone follows this view's own typed-report color
 * language (see the file header: found=patina / nothing=calm / failed=oxide / paused=brass):
 *   - `installed`     → `ok`    (patina)  — calm, done; no action
 *   - `not-installed` → `wait`  (brass)   — needs-you/actionable (NOT an error — like paused-rate-limit);
 *                                            offers Install
 *   - `installing`    → `busy`  (ember)   — active work; the breathe pulse
 *   - `checking`      → `idle`  (muted)   — transient, calm; no alarm
 *   - `install-failed`→ `error` (oxide)   — a genuine failure; offers Retry
 *   - `error`         → `error` (oxide)   — detect itself failed; offers Recheck
 * Brass-not-oxide for `not-installed` is the VIZ-10 cry-wolf call: "not yet set up" is a needs-you
 * state, not a fault — oxide is reserved for an actual install/detect failure.
 */
export type WorkIqCardState = 'checking' | 'installed' | 'not-installed' | 'installing' | 'install-failed' | 'error';

export interface WorkIqCardModel {
  state: WorkIqCardState;
  /** Secondary line: resolved CLI path (installed) / the install command (not-installed) / the failure
   *  note (install-failed/error). Derived from the IPC `WorkIqStatus` (cliPath/installCommand) by the view. */
  detail?: string;
}

export interface WorkIqCardPresentation {
  state: WorkIqCardState;
  /** The signage status line (e.g. "Installed", "Not installed", "Checking…"). */
  label: string;
  /** Trailing glyph appended to the label ("✓" when installed); '' if none. Monochrome — no emoji (§6). */
  glyph: string;
  /** Tone token → CSS `data-tone` (dot + text hue): ok=patina · wait=brass · busy=ember · error=oxide · idle=muted. */
  tone: 'ok' | 'wait' | 'busy' | 'error' | 'idle';
  /** The action affordance, or null when none. `busy` dims+breathes the button mid-install. */
  action: { label: string; busy: boolean } | null;
  /** Secondary detail text ('' if none). */
  detail: string;
  /** Whether the ember breathe applies (transient/active states); reduced-motion makes it static. */
  live: boolean;
}

export function workIqCardPresentation(model: WorkIqCardModel): WorkIqCardPresentation {
  const detail = model.detail?.trim() ?? '';
  switch (model.state) {
    case 'installed':
      return { state: model.state, label: 'Installed', glyph: '✓', tone: 'ok', action: null, detail, live: false };
    case 'not-installed':
      return { state: model.state, label: 'Not installed', glyph: '', tone: 'wait', action: { label: 'Install', busy: false }, detail, live: false };
    case 'checking':
      return { state: model.state, label: 'Checking…', glyph: '', tone: 'idle', action: null, detail: '', live: true };
    case 'installing':
      return { state: model.state, label: 'Installing…', glyph: '', tone: 'busy', action: { label: 'Install', busy: true }, detail: '', live: true };
    case 'install-failed':
      return { state: model.state, label: 'Install failed', glyph: '', tone: 'error', action: { label: 'Retry', busy: false }, detail: detail || 'The connector install did not complete.', live: false };
    case 'error':
      return { state: model.state, label: 'Status unavailable', glyph: '', tone: 'error', action: { label: 'Recheck', busy: false }, detail: detail || "Couldn't check the connector.", live: false };
  }
}

/**
 * Which config changes are risky enough to require an explicit confirm + audit (RESEARCH-15, like
 * PANEL-7): **enabling** a researcher (starts external egress), flipping to **autonomous** (its
 * findings auto-apply without Review), or **widening egress** to a more-exposed tier (more KB content
 * can leave). `prior` undefined = a brand-new researcher; enabling-on-create is risky too.
 */
export function isRiskyResearcherChange(prior: ResearcherConfig | undefined, patch: ResearcherConfigPatch): boolean {
  if (patch.enabled === true && (!prior || !prior.enabled)) return true; // turning it on
  if (patch.posture === 'autonomous' && (!prior || prior.posture !== 'autonomous')) return true; // to autonomous
  if (patch.egressTier && prior && EGRESS_EXPOSURE[patch.egressTier] > EGRESS_EXPOSURE[prior.egressTier]) return true; // widening egress
  if (patch.egressTier && !prior && patch.egressTier !== 'local-only') return true; // new researcher with external egress
  return false;
}

/** Validate an egress tier from untrusted IPC input (mirrors isSchedulePreset/isAutonomyPosture). */
export function isEgressTier(v: unknown): v is EgressTier {
  return typeof v === 'string' && (EGRESS_TIERS as readonly string[]).includes(v);
}

/** Validate a researcher template from untrusted IPC input. */
export function isResearcherTemplate(v: unknown): v is ResearcherTemplate {
  return typeof v === 'string' && (RESEARCHER_TEMPLATES as readonly string[]).includes(v);
}

/** Default egress for a template (custom defaults to the safest, local-only). */
export function defaultEgressFor(template: ResearcherTemplate): EgressTier {
  return template === 'custom' ? 'local-only' : TEMPLATE_DEFAULT_EGRESS[template];
}

const RESEARCHER_AUDIT_WHY = 'Principal change via Control Panel';

/**
 * Conforming `panel` audit events for a researcher config change (RESEARCH-15 / AUDIT-2), mirroring
 * jobConfigAuditEvents: one event per **behavior-relevant field that actually changed** (enabled /
 * schedule / posture / egressTier), carrying from→to. `patch` MUST be the **validated/applied**
 * values (not raw IPC input) so a dropped-invalid field is never recorded as applied, and a no-op
 * re-assert audits nothing. For a new researcher, `prior` is undefined → base is the safe defaults
 * (egress `local-only`), so e.g. creating a public-web researcher records local-only→public-web.
 */
export function researcherConfigAuditEvents(
  prior: Pick<ResearcherConfig, 'enabled' | 'schedule' | 'posture' | 'egressTier' | 'scope' | 'prompt' | 'budget' | 'timeoutMs' | 'orientBudget' | 'config'> | undefined,
  patch: ResearcherConfigPatch,
): AuditEventInput[] {
  const priorRepoPath = typeof prior?.config?.repoPath === 'string' ? prior.config.repoPath : '';
  const priorTenantId = typeof prior?.config?.tenantId === 'string' ? prior.config.tenantId : '';
  const priorPrRepo = typeof prior?.config?.prRepo === 'string' ? prior.config.prRepo : '';
  const base = {
    enabled: prior?.enabled ?? false,
    schedule: prior?.schedule ?? 'off',
    posture: prior?.posture ?? DEFAULT_POSTURE,
    egressTier: prior?.egressTier ?? ('local-only' as EgressTier),
    scope: prior?.scope ?? '',
    prompt: prior?.prompt ?? '',
    repoPath: priorRepoPath,
    tenantId: priorTenantId,
    prRepo: priorPrRepo,
  };
  const events: AuditEventInput[] = [];
  // scope + prompt (RESEARCH-17) + repoPath/prRepo (Code) + tenantId (M365) are steering config the
  // Principal edits in the Manage view — audited too (AUDIT-2: a change to what a researcher does /
  // which scope, repo, PR repo, or tenant it serves is never silent).
  for (const field of ['enabled', 'schedule', 'posture', 'egressTier', 'scope', 'prompt', 'repoPath', 'tenantId', 'prRepo'] as const) {
    const to = patch[field];
    if (to === undefined || to === base[field]) continue;
    events.push({
      actor: 'panel',
      eventType: 'researcher-config-change',
      subjects: { researcherId: patch.id },
      payload: { field, from: base[field], to, why: RESEARCHER_AUDIT_WHY },
    });
  }
  // The editable spend/backstop/depth/orient controls (RESEARCH-15/18/11/22): a change to the per-pass
  // budget, the session timeout, the chain-depth bound, or the orient budget is behavior-relevant → audited
  // from→to (validated/applied values only). `maxToolCalls` + `maxDepth` live under `budget`; `timeoutMs` +
  // `orientBudget` are top-level with the default as their base.
  const numericChanges: Array<{ field: 'maxToolCalls' | 'timeoutMs' | 'maxDepth' | 'orientBudget'; from: number; to: number | undefined }> = [
    { field: 'maxToolCalls', from: prior?.budget?.maxToolCalls ?? DEFAULT_RESEARCHER_BUDGET.maxToolCalls, to: patch.maxToolCalls },
    { field: 'timeoutMs', from: resolveTimeoutMs({ timeoutMs: prior?.timeoutMs }), to: patch.timeoutMs },
    { field: 'maxDepth', from: prior?.budget?.maxDepth ?? DEFAULT_RESEARCHER_BUDGET.maxDepth, to: patch.maxDepth },
    { field: 'orientBudget', from: resolveOrientBudget({ orientBudget: prior?.orientBudget }), to: patch.orientBudget },
  ];
  for (const { field, from, to } of numericChanges) {
    if (to === undefined || to === from) continue;
    events.push({
      actor: 'panel',
      eventType: 'researcher-config-change',
      subjects: { researcherId: patch.id },
      payload: { field, from, to, why: RESEARCHER_AUDIT_WHY },
    });
  }
  return events;
}
