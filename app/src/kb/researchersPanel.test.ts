// Control Panel · Researchers view-model (SPEC-0028 RESEARCH-15). Pure logic — node tier.
import { describe, it, expect } from 'vitest';
import {
  buildResearcherViews,
  lastRunFromEvent,
  isRiskyResearcherChange,
  isEgressTier,
  isResearcherTemplate,
  defaultEgressFor,
  researcherConfigAuditEvents,
  RESEARCHER_TEMPLATE_OPTIONS,
} from './researchersPanel';
import type { ResearcherConfig } from './researchers';
import type { AuditEvent } from './audit';

function web(over: Partial<ResearcherConfig> = {}): ResearcherConfig {
  return { id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: false, ...over };
}

function ev(over: Partial<AuditEvent> = {}): AuditEvent {
  return { ts: '2026-06-02T01:00:00.000Z', actor: 'researcher', eventType: 'researched', subjects: { researcherId: 'web-1', sourceId: 'SRC1' }, payload: { what: 'Project Atlas', citations: ['u1', 'u2'] }, provenance: { file: '.kb/audit.jsonl', line: 0 }, ...over };
}

describe('buildResearcherViews (RESEARCH-15)', () => {
  it('maps the registry to rows in order, overlaying last-run from audit events', () => {
    const views = buildResearcherViews([web({ id: 'web-1', label: 'Prior art', enabled: true }), web({ id: 'web-2' })], { 'web-1': ev() });
    expect(views.map((v) => v.id)).toEqual(['web-1', 'web-2']);
    expect(views[0]).toMatchObject({ label: 'Prior art', egressTier: 'public-web', enabled: true });
    expect(views[0].lastRun).toMatchObject({ eventType: 'researched', what: 'Project Atlas', sourceId: 'SRC1', citations: 2 });
    expect(views[1].lastRun).toBeNull(); // never run
    expect(views[1].label).toBe('web'); // falls back to template
    expect(views[0].prompt).toBe('p'); // instructions exposed for the Manage view (RESEARCH-17)
    expect(views[0].scope).toBe('global');
  });
});

describe('lastRunFromEvent', () => {
  it('summarizes a researched event; counts citations; handles no-finding', () => {
    expect(lastRunFromEvent(ev())).toMatchObject({ what: 'Project Atlas', citations: 2, sourceId: 'SRC1' });
    const noFind = lastRunFromEvent(ev({ eventType: 'no-finding', subjects: { researcherId: 'web-1' }, payload: { what: 'x' } }));
    expect(noFind).toMatchObject({ eventType: 'no-finding', citations: 0 });
    expect(noFind?.sourceId).toBeUndefined();
    expect(lastRunFromEvent(undefined)).toBeNull();
  });
});

describe('isRiskyResearcherChange (RESEARCH-15 confirm-gate)', () => {
  it('enabling a researcher is risky (starts external egress)', () => {
    expect(isRiskyResearcherChange(web({ enabled: false }), { id: 'web-1', enabled: true })).toBe(true);
    expect(isRiskyResearcherChange(web({ enabled: true }), { id: 'web-1', enabled: true })).toBe(false); // already on
    expect(isRiskyResearcherChange(web({ enabled: true }), { id: 'web-1', enabled: false })).toBe(false); // disabling is safe
  });

  it('flipping to autonomous is risky', () => {
    expect(isRiskyResearcherChange(web({ posture: 'guarded' }), { id: 'web-1', posture: 'autonomous' })).toBe(true);
    expect(isRiskyResearcherChange(web({ posture: 'autonomous' }), { id: 'web-1', posture: 'autonomous' })).toBe(false);
  });

  it('widening egress to a more-exposed tier is risky; narrowing is not', () => {
    expect(isRiskyResearcherChange(web({ egressTier: 'local-only' }), { id: 'web-1', egressTier: 'public-web' })).toBe(true);
    expect(isRiskyResearcherChange(web({ egressTier: 'public-web' }), { id: 'web-1', egressTier: 'local-only' })).toBe(false);
  });

  it('a new researcher with external egress is risky', () => {
    expect(isRiskyResearcherChange(undefined, { id: 'web-1', egressTier: 'public-web' })).toBe(true);
    expect(isRiskyResearcherChange(undefined, { id: 'c-1', egressTier: 'local-only' })).toBe(false);
  });
});

describe('untrusted-input validators + template defaults', () => {
  it('isEgressTier / isResearcherTemplate gate IPC input', () => {
    expect(isEgressTier('public-web')).toBe(true);
    expect(isEgressTier('exfiltrate')).toBe(false);
    expect(isResearcherTemplate('web')).toBe(true);
    expect(isResearcherTemplate('evil')).toBe(false);
  });

  it('defaultEgressFor: web=public-web, custom=local-only (safest)', () => {
    expect(defaultEgressFor('web')).toBe('public-web');
    expect(defaultEgressFor('custom')).toBe('local-only');
  });

  it('exposes the four template add-options', () => {
    expect(RESEARCHER_TEMPLATE_OPTIONS.map((o) => o.template)).toEqual(['web', 'code', 'm365', 'custom']);
  });
});

describe('researcherConfigAuditEvents (QA-2 #81 follow-up — accurate from/to audit)', () => {
  it('emits one event per CHANGED behavior-relevant field, with from/to', () => {
    const prior = web({ enabled: false, schedule: 'off', posture: 'guarded', egressTier: 'local-only' });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', enabled: true, egressTier: 'public-web' });
    expect(events.map((e) => (e.payload as { field: string }).field).sort()).toEqual(['egressTier', 'enabled']);
    const enabledEv = events.find((e) => (e.payload as { field: string }).field === 'enabled')!;
    expect(enabledEv).toMatchObject({ actor: 'panel', eventType: 'researcher-config-change', subjects: { researcherId: 'web-1' } });
    expect(enabledEv.payload).toMatchObject({ from: false, to: true });
  });

  it('audits nothing for a no-op re-assert (same value)', () => {
    const prior = web({ enabled: true, schedule: 'daily' });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', enabled: true, schedule: 'daily' })).toEqual([]);
  });

  it('for a new researcher (no prior): from = safe defaults (egress local-only)', () => {
    const events = researcherConfigAuditEvents(undefined, { id: 'web-1', egressTier: 'public-web' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'egressTier', from: 'local-only', to: 'public-web' });
  });

  it('ignores undefined (dropped-invalid) fields — only applied values are audited', () => {
    expect(researcherConfigAuditEvents(web(), { id: 'web-1' })).toEqual([]); // nothing changed
  });

  it('audits scope + prompt (instructions) changes too — RESEARCH-17 steering is never silent (AUDIT-2)', () => {
    const prior = web({ scope: 'global', prompt: 'old instructions' });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', scope: 'project-x', prompt: 'new instructions' });
    expect(events.map((e) => (e.payload as { field: string }).field).sort()).toEqual(['prompt', 'scope']);
    expect(events.find((e) => (e.payload as { field: string }).field === 'scope')!.payload).toMatchObject({ from: 'global', to: 'project-x' });
    expect(events.find((e) => (e.payload as { field: string }).field === 'prompt')!.payload).toMatchObject({ from: 'old instructions', to: 'new instructions' });
  });

  it('does not audit a prompt/scope re-assert (same value)', () => {
    expect(researcherConfigAuditEvents(web({ prompt: 'p', scope: 'global' }), { id: 'web-1', prompt: 'p', scope: 'global' })).toEqual([]);
  });
});
