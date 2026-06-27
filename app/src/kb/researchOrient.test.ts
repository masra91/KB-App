// Orient-before-egress phase (SPEC-0028 RESEARCH-22, warm-start Slice 4b). The neighborhood reader is
// INJECTED; the CONTENT gate is the REAL `sensitivityAllowsOrientRead` (DEV-2's merged SENSE module) —
// not a hand-rolled copy of the D6 rank map, so this test hinges on the actual security truth-table and
// can't drift from it (KB-QD-2 #271 hardening note; test-the-real-path). Asserts: a gap/angle + dedup set
// are produced from notebook + neighborhood; the structural floor (names) is always read but CONTENT is
// gated (the sensitivity truth table); orientBudget bounds the local reads; and THE QUERY-CONSTRUCTION
// GUARD — buildOrientedQuery can never emit a verbatim KB-dump query (the D6a/D8 security boundary).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendAuditEvent } from './audit';
import { orient, buildOrientedQuery, chooseAngle, clampAngle, ORIENT_ANGLE_MAX_CHARS, type NeighborhoodReader } from './researchOrient';
import { sensitivityAllowsOrientRead } from './sensitivity';
import { MAX_OUTBOUND_CONTEXT_CHARS } from './researchRun';
import type { ResearcherConfig, ResearchRequest } from './researchers';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-orient-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
const web = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({ id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: false, ...over });
const reqOf = (what: string, context = ''): ResearchRequest => ({ id: 'r1', ts: '2026-01-01T00:00:00.000Z', by: { stage: 'panel' }, what, why: 'w', context, dedupKey: what });

// The CONTENT gate is the REAL D6 truth-table (`sensitivityAllowsOrientRead`), imported above — orient
// always probes content at the default 'internal' rank, so: public-web (max shareable/0) → denied →
// floor only; internal-tenant (max confidential/2) → permitted; local-only → permitted.
const reader = (over: Partial<Awaited<ReturnType<NeighborhoodReader>>> = {}): NeighborhoodReader => async () => ({ found: true, centerName: 'Project Atlas', neighborNames: ['Benchmark Suite', 'Rival Corp'], contentHints: ['Atlas hit 92% on the v3 benchmark'], ...over });

describe('chooseAngle / clampAngle (the gap steer)', () => {
  it('picks a fresh signal NOT already named in the request (expand the frontier)', () => {
    const req = reqOf('Project Atlas overview');
    // frontier term "benchmark numbers" is fresh → chosen; an already-named term is skipped.
    expect(chooseAngle(req, ['Project Atlas', 'benchmark numbers'], [], [], 'Project Atlas')).toContain('benchmark numbers');
    // nothing fresh → cold subject, empty angle.
    expect(chooseAngle(reqOf('Project Atlas'), ['Project Atlas'], [], [])).toBe('');
  });
  it('clampAngle caps the steer length (never a dump)', () => {
    expect(clampAngle('x'.repeat(1000)).length).toBe(ORIENT_ANGLE_MAX_CHARS);
    expect(clampAngle('  a   b  ')).toBe('a b');
  });
});

describe('gap-driven angle (RESEARCH-24) — a MISSING facet beats the generic fresh-neighbor steer', () => {
  // The acceptance test: a generic angle (a fresh KB-neighbor name) and a gap-filling angle (a facet the
  // entity's claims don't cover) COMPETE for the steer. Gap-filling must win — otherwise the pass re-chases
  // what we already know. Hinges on the real `chooseAngle`: delete the `req.gap.missing` priority line and
  // the steer falls back to the neighbor ('Benchmark Suite') and these go red (fails-before/passes-after).
  it('picks the gap-MISSING facet over an available fresh neighbor', () => {
    const req: ResearchRequest = { ...reqOf('Project Atlas'), gap: { present: ['overview or definition'], missing: ['founding date'] } };
    const angle = chooseAngle(req, [], ['Benchmark Suite', 'Rival Corp'], [], 'Project Atlas');
    expect(angle).toContain('founding date'); // gap-filling wins
    expect(angle).not.toContain('Benchmark Suite'); // the generic neighbor lost
  });

  it('with NO gap, falls back to the generic fresh-neighbor steer (unchanged behavior)', () => {
    const angle = chooseAngle(reqOf('Project Atlas'), [], ['Benchmark Suite'], [], 'Project Atlas');
    expect(angle).toContain('Benchmark Suite');
  });

  it('a gap whose only missing facet is already named in the request is skipped (no re-establish)', () => {
    const req: ResearchRequest = { ...reqOf('Project Atlas', 'we already know its founding date'), gap: { present: [], missing: ['founding date'] } };
    // founding date is already in context → not fresh → falls through to the neighbor.
    expect(chooseAngle(req, [], ['Benchmark Suite'], [], 'Project Atlas')).toContain('Benchmark Suite');
  });

  it('through the REAL orient() path: a request carrying a gap steers the oriented query at the gap', async () => {
    await withTemp(async (root) => {
      const req: ResearchRequest = { ...reqOf('Project Atlas'), gap: { present: ['overview or definition'], missing: ['founding date'] } };
      const res = await orient(root, web({ egressTier: 'local-only', orientBudget: 5 }), req, { readNeighborhood: reader(), gate: sensitivityAllowsOrientRead });
      expect(res.angle).toContain('founding date'); // orient chose the gap, not the neighbor floor
      // "query references the gap": the oriented outbound query carries the missing facet (bounded path).
      expect(buildOrientedQuery(req, res.angle)).toContain('founding date');
    });
  });
});

describe('cross-run facet rotation (RESEARCH-QUALITY) — two runs on the same entity differ', () => {
  // The Principal's core defect: "researchers return almost the same thing each time." With a static gap a
  // re-run re-issued the IDENTICAL first-facet query. `targetedAngles` (from the field notebook) excludes a
  // facet already drilled so the steer rotates. Delete the `notDrilled` filter in chooseAngle and these go
  // red (fails-before/passes-after).
  it('chooseAngle skips a facet already drilled on a prior pass, then goes cold when all are exhausted', () => {
    const req: ResearchRequest = { ...reqOf('Acme Corp'), gap: { present: [], missing: ['founding date', 'leadership'] } };
    // founding date already drilled (the decorated angle contains it) → rotate to the next missing facet.
    expect(chooseAngle(req, [], [], [], undefined, ['re Acme Corp: founding date'])).toContain('leadership');
    // every gap facet drilled → nothing left to target → honest cold steer (don't re-issue a stale query).
    expect(chooseAngle(req, [], [], [], undefined, ['founding date', 'leadership'])).toBe('');
  });

  it('through the REAL orient() path: run 2 rotates to a different missing facet → a different query', async () => {
    await withTemp(async (root) => {
      const gap: { present: string[]; missing: string[] } = { present: [], missing: ['founding date', 'headquarters or location', 'leadership'] };
      const req: ResearchRequest = { ...reqOf('Acme Corp'), by: { stage: 'enrich', entityId: 'ent-acme' }, gap };
      const cfg = web({ egressTier: 'local-only', orientBudget: 5 });
      const noNeighbors = { readNeighborhood: reader({ found: false }), gate: sensitivityAllowsOrientRead, now: () => '2026-02-02T00:00:00.000Z' };

      // Run 1: no history → the first missing facet.
      const r1 = await orient(root, cfg, req, noNeighbors);
      expect(r1.angle).toContain('founding date');
      // Persist run 1's outcome the way runResearcher does (angle + gap on the `researched` event).
      await appendAuditEvent(root, { actor: 'researcher', eventType: 'researched', ts: '2026-02-01T00:00:00.000Z', subjects: { researcherId: 'web-1', sourceId: 'SRC1', entityId: 'ent-acme' }, payload: { what: 'Acme Corp', citations: [], angle: r1.angle, gap } });

      // Run 2: the notebook now excludes the drilled facet → orient rotates.
      const r2 = await orient(root, cfg, req, noNeighbors);
      expect(r2.angle).not.toContain('founding date');
      expect(r2.angle).toContain('headquarters or location');
      // The egress-facing artifact actually differs — that's the diversity the Principal asked for.
      expect(buildOrientedQuery(req, r1.angle)).not.toBe(buildOrientedQuery(req, r2.angle));
    });
  });
});

describe('buildOrientedQuery — THE QUERY-CONSTRUCTION GUARD (D6a/D8)', () => {
  it('an adversarial KB-dump angle can NEVER produce a verbatim-dump query (bounded by what + ≤500 ctx)', () => {
    const req = reqOf('Project Atlas');
    const dump = 'SECRET KB CONTENTS '.repeat(5000); // ~95KB raw-KB-dump angle
    const q = buildOrientedQuery(req, dump);
    // The query is bounded: request `what` + at most the capped context — nowhere near the 95KB dump.
    expect(q.length).toBeLessThanOrEqual('Project Atlas'.length + MAX_OUTBOUND_CONTEXT_CHARS + 16);
    expect(q).toContain('Project Atlas');
  });
  it('no angle → the plain request query; a small angle rides as bounded context', () => {
    expect(buildOrientedQuery(reqOf('Project Atlas'), '')).toBe('Project Atlas');
    expect(buildOrientedQuery(reqOf('Project Atlas'), 'benchmark numbers')).toContain('benchmark numbers');
  });
});

describe('orient — bounded, gated, dedup set + angle', () => {
  it('produces a dedup set (from the notebook) + a gap/angle (from the neighborhood)', async () => {
    await withTemp(async (root) => {
      await appendAuditEvent(root, { actor: 'researcher', eventType: 'researched', ts: '2026-01-01T00:00:00.000Z', subjects: { researcherId: 'web-1' }, payload: { what: 'Project Atlas overview', citations: ['https://arxiv.org/abs/1'] } });
      // `now` near the seeded event so the harvested source is within the staleness window (not aged out).
      const res = await orient(root, web({ orientBudget: 5 }), reqOf('Project Atlas'), { readNeighborhood: reader(), gate: sensitivityAllowsOrientRead, now: () => '2026-01-15T00:00:00.000Z' });
      expect(res.dedupSet.has('https://arxiv.org/abs/1')).toBe(true); // result-level dedup (RESEARCH-21)
      expect(res.floor).toEqual(['Benchmark Suite', 'Rival Corp']); // structural floor (names)
      expect(res.angle.length).toBeGreaterThan(0); // a fresh gap was chosen
      expect(res.angle.length).toBeLessThanOrEqual(ORIENT_ANGLE_MAX_CHARS);
    });
  });

  it('CONTENT read is gated by sensitivity↔tier — public-web floor-only, internal-tenant reads content', async () => {
    await withTemp(async (root) => {
      const pub = await orient(root, web({ id: 'web-1', egressTier: 'public-web', orientBudget: 5 }), reqOf('X'), { readNeighborhood: reader(), gate: sensitivityAllowsOrientRead });
      expect(pub.contentRead).toBe(false); // public-web + unlabeled('internal') → gate denies content; floor only
      const internal = await orient(root, web({ id: 'web-1', egressTier: 'internal-tenant', orientBudget: 5 }), reqOf('X'), { readNeighborhood: reader(), gate: sensitivityAllowsOrientRead });
      expect(internal.contentRead).toBe(true); // internal-tenant → gate permits content
    });
  });

  it('orientBudget bounds the local reads (a tiny budget stops before the neighborhood/content reads)', async () => {
    await withTemp(async (root) => {
      const res = await orient(root, web({ egressTier: 'local-only', orientBudget: 1 }), reqOf('X'), { readNeighborhood: reader(), gate: sensitivityAllowsOrientRead });
      expect(res.reads).toBeLessThanOrEqual(1); // budget 1 → only the notebook read; no neighborhood/content
      expect(res.floor).toEqual([]); // never reached the structural-floor read
    });
  });
});
