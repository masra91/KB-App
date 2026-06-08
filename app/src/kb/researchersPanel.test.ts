// Control Panel · Researchers view-model (SPEC-0028 RESEARCH-15). Pure logic — node tier.
import { describe, it, expect } from 'vitest';
import {
  buildResearcherViews,
  lastRunFromEvent,
  researcherOutcomeLabel,
  isRiskyResearcherChange,
  isEgressTier,
  isResearcherTemplate,
  defaultEgressFor,
  researcherConfigAuditEvents,
  researcherRunEligibility,
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
    // WS1 #6: with no explicit label, fall back to the researcher's real NAME (id) — never the generic
    // template word. `?? r.template` previously made this "web", which leaked into the run-now confirm
    // ("dispatch web/code now") and the outbound query.
    expect(views[1].label).toBe('web-2');
    expect(views[1].label).not.toBe('web'); // not the template kind
    expect(views[0].prompt).toBe('p'); // instructions exposed for the Manage view (RESEARCH-17)
    expect(views[0].scope).toBe('global');
  });

  it('surfaces the editable timeoutMs (WS3): persisted value when set, the default when absent', () => {
    const views = buildResearcherViews([web({ id: 'a', timeoutMs: 20 * 60_000 }), web({ id: 'b' })], {});
    expect(views[0].timeoutMs).toBe(20 * 60_000); // persisted
    expect(views[1].timeoutMs).toBe(15 * 60_000); // default (RESEARCH-18)
    expect(views[0].budget.maxToolCalls).toBe(8); // budget still surfaced (now editable)
  });
});

describe(`researcherRunEligibility — honest "Off" is not "won't run" (WS1 #2)`, () => {
  it('a disabled researcher truly will not run (the ENABLED switch is the real gate)', () => {
    const e = researcherRunEligibility({ enabled: false, schedule: 'off' });
    expect(e.willRun).toBe(false);
    expect(e.note).toMatch(/paused|won't run/i);
    // even a scheduled-but-disabled researcher won't run
    expect(researcherRunEligibility({ enabled: false, schedule: 'daily' }).willRun).toBe(false);
  });

  it("REGRESSION (#2): an ENABLED researcher with schedule 'off' STILL runs on demand — not paused", () => {
    // The inline dispatcher runs every enabled researcher regardless of schedule, so "schedule: Off"
    // must NOT read as won't-run (which is why such a researcher legitimately shows a recent last run).
    const e = researcherRunEligibility({ enabled: true, schedule: 'off' });
    expect(e.willRun).toBe(true);
    expect(e.note).toMatch(/on demand/i);
    expect(e.note).not.toMatch(/won't run|paused/i);
  });

  it('an enabled + scheduled researcher runs on its cadence AND on demand', () => {
    const e = researcherRunEligibility({ enabled: true, schedule: 'hourly' });
    expect(e.willRun).toBe(true);
    expect(e.note).toMatch(/hourly/i);
    expect(e.note).toMatch(/on demand/i);
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

  it('surfaces the escalation reviewId so the Field Desk can deep-link "needs your review" (RESEARCH-11)', () => {
    const esc = lastRunFromEvent(ev({ eventType: 'escalated', subjects: { researcherId: 'web-1', requestId: 'r', reviewId: 'REV123' }, payload: { what: 'Atlas' } }));
    expect(esc).toMatchObject({ eventType: 'escalated', reviewId: 'REV123' });
    // a normal pass carries no reviewId (so no dangling deep-link)
    expect(lastRunFromEvent(ev())?.reviewId).toBeUndefined();
  });
});

describe('researcherOutcomeLabel — no dev slugs in the UI (KB product principle)', () => {
  it('maps every researcher run-outcome eventType to a Principal-facing label', () => {
    expect(researcherOutcomeLabel('researched')).toBe('found sources');
    expect(researcherOutcomeLabel('no-finding')).toBe('no new findings');
    expect(researcherOutcomeLabel('research-failed')).toBe('run failed');
    expect(researcherOutcomeLabel('ceiling-reached')).toBe('paused — rate limit reached');
    expect(researcherOutcomeLabel('escalated')).toBe('paused — needs your review');
    // none of the mapped labels leak the raw kebab-case slug
    for (const slug of ['no-finding', 'research-failed', 'ceiling-reached', 'escalated']) {
      expect(researcherOutcomeLabel(slug)).not.toContain('-');
    }
  });

  it('HUMANIZES an unknown eventType (kebab → spaced) — never leaks a raw dev slug, even for a future kind', () => {
    expect(researcherOutcomeLabel('some-future-kind')).toBe('some future kind');
    expect(researcherOutcomeLabel('some-future-kind')).not.toContain('-'); // the no-slug guarantee is total
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

  it('audits a repoPath change from prior config (Slice 2a Code config — never silent)', () => {
    const prior = web({ template: 'code', egressTier: 'local-only', config: { repoPath: '/old/repo' } });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', repoPath: '/new/repo' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'repoPath', from: '/old/repo', to: '/new/repo' });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', repoPath: '/old/repo' })).toEqual([]); // no-op re-assert
  });

  it('audits a prRepo change from prior config (Slice 2b Code PR config — never silent)', () => {
    const prior = web({ template: 'code', egressTier: 'local-only', config: { prRepo: 'octocat/old' } });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', prRepo: 'octocat/new' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'prRepo', from: 'octocat/old', to: 'octocat/new' });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', prRepo: 'octocat/old' })).toEqual([]); // no-op re-assert
  });

  it('audits a tenantId change from prior config (Slice 3 M365 config — never silent)', () => {
    const prior = web({ template: 'm365', egressTier: 'internal-tenant', config: { tenantId: 'contoso.onmicrosoft.com' } });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', tenantId: 'fabrikam.onmicrosoft.com' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'tenantId', from: 'contoso.onmicrosoft.com', to: 'fabrikam.onmicrosoft.com' });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', tenantId: 'contoso.onmicrosoft.com' })).toEqual([]); // no-op re-assert
  });

  it('audits an editable maxToolCalls change from→to (WS3 — spend ceiling change is never silent)', () => {
    const prior = web({ budget: { maxToolCalls: 8, maxDepth: 2 } });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', maxToolCalls: 30 });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'maxToolCalls', from: 8, to: 30 });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', maxToolCalls: 8 })).toEqual([]); // no-op re-assert
  });

  it('audits an editable timeoutMs change from→to, with the default as the base when none was persisted (WS3)', () => {
    const events = researcherConfigAuditEvents(web(), { id: 'web-1', timeoutMs: 20 * 60_000 });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'timeoutMs', from: 15 * 60_000, to: 20 * 60_000 }); // base = default
    const prior = web({ timeoutMs: 20 * 60_000 });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', timeoutMs: 20 * 60_000 })).toEqual([]); // no-op re-assert
  });

  it('audits an editable maxDepth change from→to (WS3 Slice-2 — chain-depth bound change is never silent)', () => {
    const prior = web({ budget: { maxToolCalls: 8, maxDepth: 2 } });
    const events = researcherConfigAuditEvents(prior, { id: 'web-1', maxDepth: 5 });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ field: 'maxDepth', from: 2, to: 5 });
    expect(researcherConfigAuditEvents(prior, { id: 'web-1', maxDepth: 2 })).toEqual([]); // no-op re-assert
  });
});
