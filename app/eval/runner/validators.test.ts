// SPEC-0042 EVAL Slice-1 — the deterministic validator library (EVAL-3) + scorecard (EVAL-8). Pure,
// deterministic — asserts each check over synthetic VaultSnapshots (no copilot), so it runs in normal CI.
// This is the durable home for the asserts enrichE2eDogfood hand-wired (DECOMP-17 granularity, claim
// citations, CONNECT-12 wikilinks, ASK-7 recall citations).
import { describe, it, expect } from 'vitest';
import { runDeterministicChecks, VALIDATORS } from './validators';
import { buildScorecard, formatScorecard } from './scorecard';
import type { VaultSnapshot } from './snapshot';
import type { AskResult } from '../../src/kb/recall';

function snap(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return { root: '/v', entities: [], claims: [], sources: [], outputs: [], recall: null, audit: [], spans: [], devLog: [], ...over };
}
const ask = (over: Partial<AskResult> = {}): AskResult => ({ question: 'q', answer: 'a', citations: [], grounded: false, toolCalls: 0, truncated: false, ...over });

describe('entitiesInclude / entitiesExclude (DECOMP-17 — entities are nodes, descriptors are not)', () => {
  const s = snap({
    entities: [
      { path: 'entities/person/grace-hopper.md', body: '# Grace Hopper\nWorked on COBOL.' },
      { path: 'entities/org/us-navy.md', body: '# US Navy\n' },
    ],
  });
  it('include passes when every named entity exists; fails (named) when one is missing', () => {
    expect(VALIDATORS.entitiesInclude(s, ['Grace Hopper', 'US Navy']).pass).toBe(true);
    const miss = VALIDATORS.entitiesInclude(s, ['Grace Hopper', 'COBOL']);
    expect(miss.pass).toBe(false);
    expect(miss.detail).toMatch(/COBOL/);
  });
  it('exclude passes when no descriptor became a node; fails when one leaked', () => {
    expect(VALIDATORS.entitiesExclude(s, ['rear admiral', 'pioneer']).pass).toBe(true);
    const leaked = snap({ entities: [...s.entities, { path: 'entities/concept/rear-admiral.md', body: '# rear admiral\n' }] });
    expect(VALIDATORS.entitiesExclude(leaked, ['rear admiral']).pass).toBe(false);
  });
});

describe('claimCitations (CLAIMS / VAULT-13)', () => {
  it('passes when every claim carries a source link or derivedFrom; fails otherwise', () => {
    const cited = snap({ claims: [{ path: 'claims/a.md', body: '...\n[[sources/2026/05/x/source.md|note]]' }, { path: 'claims/b.md', body: '  derivedFrom: [sources/2026/05/y]' }] });
    expect(VALIDATORS.claimCitations(cited, { required: true }).pass).toBe(true);
    const uncited = snap({ claims: [{ path: 'claims/a.md', body: 'a bare statement, no citation' }] });
    const r = VALIDATORS.claimCitations(uncited, { required: true });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/claims\/a\.md/);
  });
  it('fails when required but there are no claims', () => {
    expect(VALIDATORS.claimCitations(snap({ claims: [] }), { required: true }).pass).toBe(false);
  });
});

describe('wikilinkRendered (CONNECT-12 — relatesTo → [[link]])', () => {
  const s = snap({ entities: [{ path: 'entities/person/grace-hopper.md', body: '# Grace Hopper\n- [[entities/org/us-navy.md|US Navy]]' }, { path: 'entities/org/us-navy.md', body: '# US Navy' }] });
  it('passes when the from-entity links to the to-entity', () => {
    expect(VALIDATORS.wikilinkRendered(s, { from: 'Grace Hopper', to: 'US Navy' }).pass).toBe(true);
  });
  it('fails when the link is absent', () => {
    expect(VALIDATORS.wikilinkRendered(s, { from: 'US Navy', to: 'Grace Hopper' }).pass).toBe(false);
  });
});

describe('recall + count + audit checks', () => {
  it('recallCites honors min', () => {
    expect(VALIDATORS.recallCites(snap({ recall: ask({ citations: [{} as never] }) }), { min: 1 }).pass).toBe(true);
    expect(VALIDATORS.recallCites(snap({ recall: ask({ citations: [] }) }), { min: 1 }).pass).toBe(false);
    expect(VALIDATORS.recallCites(snap({ recall: null }), { min: 1 }).pass).toBe(false);
  });
  it('recallContains is case-insensitive', () => {
    expect(VALIDATORS.recallContains(snap({ recall: ask({ answer: 'She worked on COBOL.' }) }), { text: 'cobol' }).pass).toBe(true);
  });
  it('countBounds enforces a file-count range', () => {
    const s = snap({ entities: [{ path: 'e/a.md', body: '' }, { path: 'e/b.md', body: '' }] });
    expect(VALIDATORS.countBounds(s, { dir: 'entities', min: 1, max: 3 }).pass).toBe(true);
    expect(VALIDATORS.countBounds(s, { dir: 'entities', max: 1 }).pass).toBe(false);
  });
  it('auditEvents counts by type', () => {
    const s = snap({ audit: [{ eventType: 'researched' } as never, { eventType: 'researched' } as never, { eventType: 'no-finding' } as never] });
    expect(VALIDATORS.auditEvents(s, { eventType: 'researched', min: 2 }).pass).toBe(true);
    expect(VALIDATORS.auditEvents(s, { eventType: 'researched', min: 3 }).pass).toBe(false);
  });
});

describe('runDeterministicChecks + scorecard', () => {
  it('an unknown check fails loudly (never a silent skip)', () => {
    const [r] = runDeterministicChecks(snap(), [{ check: 'doesNotExist' }]);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/unknown deterministic check/);
  });
  it('buildScorecard aggregates pass/fail; formatScorecard renders ✓/✗ lines', () => {
    const s = snap({ entities: [{ path: 'entities/person/ada.md', body: '# Ada' }] });
    const checks = runDeterministicChecks(s, [
      { check: 'entitiesInclude', args: ['Ada'] },
      { check: 'entitiesInclude', args: ['Babbage'] },
    ]);
    const sc = buildScorecard('demo', 'decompose', checks);
    expect(sc).toMatchObject({ passed: 1, failed: 1, total: 2, ok: false });
    const out = formatScorecard(sc);
    expect(out).toMatch(/✗ demo/);
    expect(out).toMatch(/✓ entitiesInclude/);
    expect(out).toMatch(/✗ entitiesInclude/);
  });
});

// SPEC-0042 robustness (corrupted-vault eval) — the crash-class guard: a corrupted item must set
// aside gracefully (a `setaside` span) and its failure must be surfaced in telemetry (a dev-log
// `error` with a message), never a silent fatal drain crash.
describe('spanOutcome (robustness — graceful set-aside via telemetry)', () => {
  const span = (over: Record<string, unknown> = {}) => ({ spanId: '1', op: 'stage.run', stage: 'connect', startTs: 't0', endTs: 't1', durationMs: 1, outcome: 'ok', ...over }) as VaultSnapshot['spans'][number];

  it('passes when ≥min spans carry the outcome (a corrupted item was set aside; good items completed)', () => {
    const s = snap({ spans: [span({ spanId: 'a', itemId: 'bad', outcome: 'setaside' }), span({ spanId: 'b', itemId: 'good', outcome: 'ok' })] });
    expect(VALIDATORS.spanOutcome(s, { outcome: 'setaside', min: 1 }).pass).toBe(true);
    expect(VALIDATORS.spanOutcome(s, { outcome: 'ok', min: 1 }).pass).toBe(true);
  });

  it('FAILS when no span carries the outcome — the regression: drain died with no graceful set-aside span', () => {
    const s = snap({ spans: [span({ outcome: 'ok' })] });
    expect(VALIDATORS.spanOutcome(s, { outcome: 'setaside' }).pass).toBe(false);
  });

  it('scopes to a stage when given', () => {
    const s = snap({ spans: [span({ stage: 'claims', outcome: 'setaside' })] });
    expect(VALIDATORS.spanOutcome(s, { outcome: 'setaside', stage: 'connect' }).pass).toBe(false);
    expect(VALIDATORS.spanOutcome(s, { outcome: 'setaside', stage: 'claims' }).pass).toBe(true);
  });
});

describe('telemetryError (robustness — failure surfaced with a message)', () => {
  const errEntry = (over: Record<string, unknown> = {}) => ({ ts: 't', level: 'error', event: 'connect.link-error', err: { message: 'ENOENT: missing source dir' }, ...over }) as VaultSnapshot['devLog'][number];

  it('passes when ≥min dev-log error entries exist (failure logged, not swallowed)', () => {
    expect(VALIDATORS.telemetryError(snap({ devLog: [errEntry()] }), {}).pass).toBe(true);
  });

  it('matches a `contains` substring across the entry (message / event / item id)', () => {
    const s = snap({ devLog: [errEntry()] });
    expect(VALIDATORS.telemetryError(s, { contains: 'ENOENT' }).pass).toBe(true);
    expect(VALIDATORS.telemetryError(s, { contains: 'link-error' }).pass).toBe(true);
    expect(VALIDATORS.telemetryError(s, { contains: 'not-present' }).pass).toBe(false);
  });

  it('FAILS when the failure was swallowed — the "errors logged nowhere" gap (no error entries)', () => {
    const s = snap({ devLog: [{ ts: 't', level: 'warn', event: 'noise' } as VaultSnapshot['devLog'][number]] });
    expect(VALIDATORS.telemetryError(s, {}).pass).toBe(false);
  });
});
