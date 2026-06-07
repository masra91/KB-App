// Sources view-model tests (SPEC-0027 PANEL-4 / INTAKE-14) — pure, DOM-free. Asserts the registry→row
// mapping, last-run derivation, risky-change (enable) detection, the item-cap clamp, the no-slug outcome
// labels, and that config-change audit events record only actually-changed, validated fields.
import { describe, it, expect } from 'vitest';
import {
  buildIntakeConnectorViews,
  lastRunFromIntakeEvent,
  intakeOutcomeLabel,
  isRiskyIntakeChange,
  isIntakeConnectorType,
  clampMaxItems,
  intakeConfigAuditEvents,
  intakeRunEligibility,
  INTAKE_CONNECTOR_CATALOG,
} from './intakeSourcingPanel';
import type { IntakeConnectorConfig } from './intakeConnectors';
import type { AuditEvent } from './audit';

const conn = (over: Partial<IntakeConnectorConfig> = {}): IntakeConnectorConfig => ({
  id: 'news', type: 'rss', schedule: 'hourly', enabled: true, scope: 'global', sensitivity: 'internal',
  config: { feedUrl: 'https://example.com/feed.xml' }, ...over,
});

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  ts: '2025-06-03T09:00:00.000Z', actor: 'intake', eventType: 'intook', subjects: { intakeId: 'news' },
  payload: { count: 3 }, provenance: { file: '.kb/control/audit.jsonl', line: 1 }, ...over,
} as AuditEvent);

describe('intakeSourcingPanel (INTAKE-14)', () => {
  it('builds rows from the registry, overlaying last-run + type label', () => {
    const rows = buildIntakeConnectorViews([conn()], { news: event() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'news', type: 'rss', typeLabel: 'RSS / Atom feed', label: 'news', feedUrl: 'https://example.com/feed.xml', maxItemsPerPass: 25 });
    expect(rows[0].lastRun).toMatchObject({ eventType: 'intook', count: 3 });
  });

  it('row has null lastRun when the connector never ran', () => {
    expect(buildIntakeConnectorViews([conn()], {})[0].lastRun).toBeNull();
  });

  it('lastRunFromIntakeEvent surfaces a failure error (failed≠empty)', () => {
    const lr = lastRunFromIntakeEvent(event({ eventType: 'intake-failed', payload: { error: 'feed unreachable' } }));
    expect(lr).toMatchObject({ eventType: 'intake-failed', count: 0, error: 'feed unreachable' });
  });

  it('intakeOutcomeLabel never leaks a raw slug', () => {
    expect(intakeOutcomeLabel('intook')).toBe('pulled new items');
    expect(intakeOutcomeLabel('no-new-items')).toBe('no new items');
    expect(intakeOutcomeLabel('intake-failed')).toBe('pull failed');
    expect(intakeOutcomeLabel('some-future-slug')).toBe('some future slug'); // humanized, never raw
  });

  it('isRiskyIntakeChange: enabling (incl. on create) is risky; other edits are not', () => {
    expect(isRiskyIntakeChange(conn({ enabled: false }), { id: 'news', enabled: true })).toBe(true); // turning on
    expect(isRiskyIntakeChange(undefined, { id: 'news', enabled: true })).toBe(true); // new + enabled
    expect(isRiskyIntakeChange(conn({ enabled: true }), { id: 'news', schedule: 'daily' })).toBe(false); // already on, schedule change
    expect(isRiskyIntakeChange(conn({ enabled: true }), { id: 'news', enabled: false })).toBe(false); // disabling is safe
  });

  it('clampMaxItems clamps to the sane range + drops garbage', () => {
    expect(clampMaxItems(50)).toBe(50);
    expect(clampMaxItems(9999)).toBe(200); // ceiling
    expect(clampMaxItems(0)).toBeUndefined(); // ≤0 dropped
    expect(clampMaxItems(12.5)).toBeUndefined(); // non-integer dropped
    expect(clampMaxItems('25' as unknown)).toBeUndefined(); // non-numeric dropped
  });

  it('isIntakeConnectorType validates the union', () => {
    expect(isIntakeConnectorType('rss')).toBe(true);
    expect(isIntakeConnectorType('m365-mail')).toBe(true);
    expect(isIntakeConnectorType('imap')).toBe(false);
  });

  it('intakeConfigAuditEvents records only actually-changed fields (from→to)', () => {
    const events = intakeConfigAuditEvents(conn({ enabled: false, scope: 'global' }), { id: 'news', enabled: true, scope: 'global', schedule: 'daily' });
    const fields = events.map((e) => e.payload.field);
    expect(fields).toContain('enabled'); // changed false→true
    expect(fields).toContain('schedule'); // changed hourly→daily
    expect(fields).not.toContain('scope'); // unchanged (global→global) → no event
    expect(events.every((e) => e.actor === 'panel' && e.eventType === 'intake-config-change' && e.subjects.intakeId === 'news')).toBe(true);
  });

  it('intakeConfigAuditEvents: a new connector records from the safe defaults', () => {
    const events = intakeConfigAuditEvents(undefined, { id: 'news', enabled: true, sensitivity: 'confidential' });
    const enabled = events.find((e) => e.payload.field === 'enabled');
    const sens = events.find((e) => e.payload.field === 'sensitivity');
    expect(enabled?.payload).toMatchObject({ from: false, to: true });
    expect(sens?.payload).toMatchObject({ from: 'internal', to: 'confidential' }); // default internal → confidential
  });

  it('intakeRunEligibility: disabled won’t pull; enabled+off pulls on demand', () => {
    expect(intakeRunEligibility({ enabled: false, schedule: 'hourly' }).willRun).toBe(false);
    expect(intakeRunEligibility({ enabled: true, schedule: 'off' })).toMatchObject({ willRun: true, note: expect.stringMatching(/on demand/) });
  });

  it('the catalog ships RSS + M365-mail templates', () => {
    expect(INTAKE_CONNECTOR_CATALOG.map((e) => e.type)).toEqual(['rss', 'm365-mail']);
  });
});
