// Control Panel · Sources — pure view-model logic for INTAKE feed connectors (SPEC-0027 PANEL-4 /
// INTAKE-14). DOM-free + side-effect-free (SHELL-6 / TEST-5): the main process gathers the fs-backed
// inputs (registry + last-run audit events) and hands them here; the renderer renders the result.
// Mirrors researchersPanel/jobsPanel. WATCH watched-folders join this same Sources view via their own
// view-model once the WATCH backend's registry/IPC seam lands (WATCH-9).
import {
  INTAKE_CONNECTOR_TYPES,
  DEFAULT_INTAKE_SCOPE,
  DEFAULT_INTAKE_SENSITIVITY,
  DEFAULT_MAX_ITEMS_PER_PASS,
  type IntakeConnectorConfig,
  type IntakeConnectorType,
} from './intakeConnectors';
import { schedulePresetLabel, SCHEDULE_OPTIONS } from './jobsPanel';
import type { AuditEvent, AuditEventInput } from './audit';
import type { IntakeConnectorView, IntakeConnectorLastRun, IntakeConnectorConfigPatch } from './types';

export { schedulePresetLabel, SCHEDULE_OPTIONS };

/** An add-from-template option for the Sources view (INTAKE-5/14). Slice 1 ships RSS; M365-mail is a
 *  present option whose live tenant wiring is env-gated (its connector lands as registered config). */
export interface IntakeConnectorCatalogEntry {
  type: IntakeConnectorType;
  label: string;
  description: string;
}

export const INTAKE_CONNECTOR_CATALOG: IntakeConnectorCatalogEntry[] = [
  { type: 'rss', label: 'RSS / Atom feed', description: 'Pull new items from a public RSS/Atom feed into your KB on a schedule.' },
  { type: 'm365-mail', label: 'Microsoft 365 mail', description: 'Pull new mail from your M365 mailbox (your tenant, read-only). Live wiring is env-gated.' },
];

/** Principal-facing type label for a connector type (never the dev slug in the UI). */
export function intakeTypeLabel(type: IntakeConnectorType): string {
  return INTAKE_CONNECTOR_CATALOG.find((e) => e.type === type)?.label ?? type.replace(/-/g, ' ');
}

/** Bounds for the editable per-pass item cap (INTAKE-11): a sane floor/ceiling so a UI value can't make
 *  a pass drain an entire feed or no-op. */
export const MIN_MAX_ITEMS_PER_PASS = 1;
export const MAX_MAX_ITEMS_PER_PASS = 200;

/** Clamp an untrusted `maxItemsPerPass` from IPC to the sane integer range, or undefined to drop garbage
 *  (non-numeric / ≤0 / non-integer) so the field is left unchanged (mirrors clampToolCalls). */
export function clampMaxItems(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) return undefined;
  return Math.min(MAX_MAX_ITEMS_PER_PASS, Math.max(MIN_MAX_ITEMS_PER_PASS, v));
}

/** The intake run-outcome audit kinds (`runIntakeConnector` emits these as `eventType`). */
export type IntakeOutcomeKind = 'intook' | 'no-new-items' | 'intake-failed';

/** Principal-facing labels for each intake run-outcome kind — never the raw dev slug in the UI. TOTAL
 *  over the union so adding a kind is a compile error until labeled here (the no-slug guarantee). */
const INTAKE_OUTCOME_LABELS: Record<IntakeOutcomeKind, string> = {
  intook: 'pulled new items',
  'no-new-items': 'no new items',
  'intake-failed': 'pull failed',
};

/** Map an intake run-outcome `eventType` to its Principal-facing label; an unknown kind is humanized
 *  (kebab → spaced) so even a future slug never leaks raw to the UI. */
export function intakeOutcomeLabel(eventType: string): string {
  if (Object.prototype.hasOwnProperty.call(INTAKE_OUTCOME_LABELS, eventType)) {
    return INTAKE_OUTCOME_LABELS[eventType as IntakeOutcomeKind];
  }
  return eventType.replace(/-/g, ' ');
}

/** Derive a connector's last-run summary from its newest `intake` audit event (or null). */
export function lastRunFromIntakeEvent(event: AuditEvent | undefined): IntakeConnectorLastRun | null {
  if (!event) return null;
  const p = event.payload;
  return {
    ts: event.ts,
    eventType: event.eventType,
    count: typeof p.count === 'number' ? p.count : 0,
    ...(typeof p.error === 'string' ? { error: p.error } : {}),
  };
}

/** A connector's string config field, or '' when unset. */
function cfgStr(c: IntakeConnectorConfig, key: string): string {
  const v = c.config?.[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Map the intake registry into display rows (INTAKE-14), overlaying each connector's last-run from
 * `lastEventByConnectorId`. Like researchers, all connectors are Principal-created from templates
 * (INTAKE_CONNECTOR_CATALOG is the add list, not pre-registered rows). Rows in registry order.
 */
export function buildIntakeConnectorViews(
  registry: IntakeConnectorConfig[],
  lastEventByConnectorId: Record<string, AuditEvent | undefined>,
): IntakeConnectorView[] {
  return registry.map((c) => ({
    id: c.id,
    type: c.type,
    typeLabel: intakeTypeLabel(c.type),
    label: c.label ?? c.id,
    enabled: c.enabled,
    schedule: c.schedule,
    scope: c.scope,
    sensitivity: c.sensitivity,
    maxItemsPerPass: c.maxItemsPerPass && c.maxItemsPerPass > 0 ? c.maxItemsPerPass : DEFAULT_MAX_ITEMS_PER_PASS,
    feedUrl: cfgStr(c, 'feedUrl'),
    tenantId: cfgStr(c, 'tenantId'),
    folder: cfgStr(c, 'folder'),
    lastRun: lastRunFromIntakeEvent(lastEventByConnectorId[c.id]),
  }));
}

/** Honest run-eligibility for a connector (mirrors the researcher surface): a disabled connector won't
 *  pull; an enabled one with schedule `off` runs only on-demand (Run now). */
export function intakeRunEligibility(c: Pick<IntakeConnectorView, 'enabled' | 'schedule'>): { willRun: boolean; note: string } {
  if (!c.enabled) return { willRun: false, note: "Paused — won't pull until enabled" };
  if (c.schedule === 'off') return { willRun: true, note: 'Pulls on demand (no schedule)' };
  return { willRun: true, note: `Pulls ${schedulePresetLabel(c.schedule).toLowerCase()} + on demand` };
}

/**
 * Which config changes require an explicit confirm + audit (INTAKE-14, like PANEL-7): **enabling** a
 * connector starts an outbound pull (egress to the feed/tenant), so enabling — including enabling-on-
 * create — is the risky change. `prior` undefined = a brand-new connector.
 */
export function isRiskyIntakeChange(prior: IntakeConnectorConfig | undefined, patch: IntakeConnectorConfigPatch): boolean {
  return patch.enabled === true && (!prior || !prior.enabled);
}

/** Validate an intake connector type from untrusted IPC input. */
export function isIntakeConnectorType(v: unknown): v is IntakeConnectorType {
  return typeof v === 'string' && (INTAKE_CONNECTOR_TYPES as readonly string[]).includes(v);
}

const INTAKE_AUDIT_WHY = 'Principal change via Control Panel';

/**
 * Conforming `panel` audit events for a connector config change (INTAKE-14 / AUDIT-2), mirroring
 * researcherConfigAuditEvents: one event per behavior-relevant field that ACTUALLY changed, carrying
 * from→to. `patch` MUST be the validated/applied values so a dropped-invalid field is never recorded
 * as applied and a no-op re-assert audits nothing. For a new connector, `prior` is undefined → base is
 * the safe defaults (scope `global`, sensitivity `internal`, disabled).
 */
export function intakeConfigAuditEvents(
  prior: Pick<IntakeConnectorConfig, 'enabled' | 'schedule' | 'scope' | 'sensitivity' | 'maxItemsPerPass' | 'config'> | undefined,
  patch: IntakeConnectorConfigPatch,
): AuditEventInput[] {
  const base = {
    enabled: prior?.enabled ?? false,
    schedule: prior?.schedule ?? 'off',
    scope: prior?.scope ?? DEFAULT_INTAKE_SCOPE,
    sensitivity: prior?.sensitivity ?? DEFAULT_INTAKE_SENSITIVITY,
    feedUrl: typeof prior?.config?.feedUrl === 'string' ? prior.config.feedUrl : '',
    tenantId: typeof prior?.config?.tenantId === 'string' ? prior.config.tenantId : '',
    folder: typeof prior?.config?.folder === 'string' ? prior.config.folder : '',
  };
  const events: AuditEventInput[] = [];
  for (const field of ['enabled', 'schedule', 'scope', 'sensitivity', 'feedUrl', 'tenantId', 'folder'] as const) {
    const to = patch[field];
    if (to === undefined || to === base[field]) continue;
    events.push({
      actor: 'panel',
      eventType: 'intake-config-change',
      subjects: { intakeId: patch.id },
      payload: { field, from: base[field], to, why: INTAKE_AUDIT_WHY },
    });
  }
  // The editable per-pass item cap (INTAKE-11) is behavior-relevant → audited from→to (applied value only).
  const fromMax = prior?.maxItemsPerPass && prior.maxItemsPerPass > 0 ? prior.maxItemsPerPass : DEFAULT_MAX_ITEMS_PER_PASS;
  if (patch.maxItemsPerPass !== undefined && patch.maxItemsPerPass !== fromMax) {
    events.push({
      actor: 'panel',
      eventType: 'intake-config-change',
      subjects: { intakeId: patch.id },
      payload: { field: 'maxItemsPerPass', from: fromMax, to: patch.maxItemsPerPass, why: INTAKE_AUDIT_WHY },
    });
  }
  return events;
}
