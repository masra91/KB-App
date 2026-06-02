// Canonical audit model + coverage gate (SPEC-0029 AUDIT-1/2/3/11).
//
// Two halves: (1) the normalizer maps each emitter's REAL line shape onto the canonical envelope —
// table-driven over the exact shapes the stages emit (AUDIT-1); (2) the coverage gate scans
// src/kb for audit emitters and asserts every one is registered with the *why* (AUDIT-2/11). The
// gate is the obligation KB-Quality-Driver leans on: a new feature that emits audit but forgets to
// register here fails this test.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeAuditLine, AUDIT_ACTORS, AUDIT_COVERAGE, coverageFor, type NormalizeContext } from './audit';

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({ file: 'sources/2026/01/S1/audit.jsonl', line: 0, ...over });

describe('normalizeAuditLine — per-actor adapters (AUDIT-1)', () => {
  it('archivist `archived` line: ts←archivedAt, actor, sourceId←id, model←agent.model', () => {
    const raw = { action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: { route: 'keep' }, agent: { via: 'copilot', model: 'gpt-x' } };
    const e = normalizeAuditLine(raw, ctx())!;
    expect(e).toMatchObject({ actor: 'archivist', eventType: 'archived', ts: '2026-01-01T00:00:00.000Z', model: 'gpt-x' });
    expect(e.subjects.sourceId).toBe('S1');
    expect(e.payload.decision).toEqual({ route: 'keep' });
    expect(e.provenance).toEqual({ file: 'sources/2026/01/S1/audit.jsonl', line: 0 });
  });

  it('decompose `decomposed` line: actor from stage, candidates in payload', () => {
    const raw = { ts: '2026-01-02T00:00:00.000Z', stage: 'decompose', runId: 'R1', sourceId: 'S1', model: 'm', event: 'decomposed', candidates: 3 };
    const e = normalizeAuditLine(raw, ctx())!;
    expect(e).toMatchObject({ actor: 'decompose', eventType: 'decomposed', runId: 'R1', model: 'm' });
    expect(e.subjects.sourceId).toBe('S1');
    expect(e.payload).toEqual({ candidates: 3 });
  });

  it('claims `claimed` line: entityId + sourceId subjects, claims count in payload', () => {
    const raw = { ts: '2026-01-03T00:00:00.000Z', stage: 'claims', runId: 'R2', entityId: 'E1', sourceId: 'S1', model: 'm', event: 'claimed', claims: 2 };
    const e = normalizeAuditLine(raw, ctx())!;
    expect(e.actor).toBe('claims');
    expect(e.subjects).toEqual({ entityId: 'E1', sourceId: 'S1' });
    expect(e.payload).toEqual({ claims: 2 });
  });

  it('connect `resolved` line: recovers entityId from the node rel path', () => {
    const raw = { ts: '2026-01-04T00:00:00.000Z', stage: 'connect', runId: 'R3', blockKey: 'person|atlas', model: 'm', event: 'resolved', node: 'entities/2026/01/E9.md', candidates: 3, merged: 2 };
    const e = normalizeAuditLine(raw, ctx({ file: 'connect/audit.jsonl' }))!;
    expect(e.actor).toBe('connect');
    expect(e.subjects).toEqual({ blockKey: 'person|atlas', entityId: 'E9' });
    expect(e.payload).toMatchObject({ candidates: 3, merged: 2, node: 'entities/2026/01/E9.md' });
  });

  it('job journal entry: no `event`/`stage`; actor + jobId from path, eventType synthesized', () => {
    const raw = { ts: '2026-01-05T00:00:00.000Z', runId: 'R4', inspected: 10, applied: 2, deferred: 1 };
    const e = normalizeAuditLine(raw, ctx({ file: '.kb/jobs/reflect/journal.jsonl', jobId: 'reflect' }))!;
    expect(e).toMatchObject({ actor: 'job', eventType: 'job-run', runId: 'R4' });
    expect(e.subjects.jobId).toBe('reflect');
    expect(e.payload).toEqual({ inspected: 10, applied: 2, deferred: 1 });
  });

  it('recall line: actor from event, question in payload', () => {
    const raw = { ts: '2026-01-06T00:00:00.000Z', event: 'recall', question: 'who is Atlas?', grounded: true, agent: { model: 'copilot' } };
    const e = normalizeAuditLine(raw, ctx({ file: '.kb/ask/audit.jsonl' }))!;
    expect(e).toMatchObject({ actor: 'recall', eventType: 'recall', model: 'copilot' });
    expect(e.payload).toMatchObject({ question: 'who is Atlas?', grounded: true });
  });

  it('replay-reset marker: actor replay regardless of file it rides in', () => {
    const raw = { ts: '2026-01-07T00:00:00.000Z', event: 'replay-reset', replayId: 'Z1' };
    const e = normalizeAuditLine(raw, ctx())!;
    expect(e).toMatchObject({ actor: 'replay', eventType: 'replay-reset' });
    expect(e.payload).toEqual({ replayId: 'Z1' });
  });

  it('review-answered marker (from reviewStore) normalizes to its raising stage, carries verdict', () => {
    const raw = { ts: '2026-01-08T00:00:00.000Z', stage: 'claims', event: 'review-answered', reviewId: 'V1', question: 'q', verdict: 'confirm', entityId: 'E1' };
    const e = normalizeAuditLine(raw, ctx())!;
    expect(e.actor).toBe('claims');
    expect(e.eventType).toBe('review-answered');
    expect(e.subjects).toEqual({ reviewId: 'V1', entityId: 'E1' });
    expect(e.payload).toMatchObject({ verdict: 'confirm', question: 'q' });
  });

  it('returns null for foreign / malformed / timestamp-less lines (skipped, never fabricated)', () => {
    expect(normalizeAuditLine({ hello: 'world' }, ctx())).toBeNull(); // no recognizable actor
    expect(normalizeAuditLine({ stage: 'claims', event: 'claimed' }, ctx())).toBeNull(); // no ts
    expect(normalizeAuditLine(null, ctx())).toBeNull();
    expect(normalizeAuditLine('a string', ctx())).toBeNull();
    expect(normalizeAuditLine([1, 2], ctx())).toBeNull();
  });
});

describe('AUDIT_COVERAGE — the coverage gate (AUDIT-2/11)', () => {
  const kbDir = __dirname;

  it('every actor in the union has exactly one coverage entry', () => {
    for (const actor of AUDIT_ACTORS) {
      const entries = AUDIT_COVERAGE.filter((c) => c.actor === actor);
      expect(entries, `actor ${actor} must be registered`).toHaveLength(1);
      expect(coverageFor(actor)).toBeDefined();
    }
    // No stray entries for unknown actors.
    for (const c of AUDIT_COVERAGE) expect(AUDIT_ACTORS).toContain(c.actor);
  });

  it('every mutating actor records the *why* (AUDIT-2 — no silent actions)', () => {
    for (const c of AUDIT_COVERAGE) {
      if (c.mutating) expect(c.carriesWhy, `${c.actor} mutates the KB → must carry the why`).toBe(true);
      expect(c.traces.length, `${c.actor} must trace to a requirement`).toBeGreaterThan(0);
    }
  });

  it('every registered emitter module exists in src/kb', async () => {
    const registered = [...new Set(AUDIT_COVERAGE.flatMap((c) => c.emitters))];
    for (const mod of registered) {
      await expect(fs.access(path.join(kbDir, `${mod}.ts`)), `emitter ${mod}.ts should exist`).resolves.toBeUndefined();
    }
  });

  it('NO unregistered emitter: every src/kb file that appends audit/journal is in the registry', async () => {
    const registered = new Set(AUDIT_COVERAGE.flatMap((c) => c.emitters));
    const files = (await fs.readdir(kbDir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const emitters: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(path.join(kbDir, f), 'utf8');
      const appends = /append(File|Audit)\s*\(/.test(src);
      const auditPath = /(audit|journal)\.jsonl/.test(src);
      if (appends && auditPath) emitters.push(f.replace(/\.ts$/, ''));
    }
    // Sanity: the scan actually finds the known producers (guards against a broken detector).
    expect(emitters).toEqual(expect.arrayContaining(['orchestrator', 'decomposeStage', 'claimsStage', 'connectStage', 'jobStage', 'recall', 'replay']));
    for (const e of emitters) {
      expect(registered.has(e), `${e}.ts appends audit but is not in AUDIT_COVERAGE — register it with the why (AUDIT-11)`).toBe(true);
    }
  });
});
