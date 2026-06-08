// Orient-before-egress phase (SPEC-0028 RESEARCH-22, warm-start Slice 4b). The gate (DEV-2's
// sensitivityAllowsOrientRead) + the neighborhood reader are INJECTED. Asserts: a gap/angle + dedup set
// are produced from notebook + neighborhood; the structural floor (names) is always read but CONTENT is
// gated (the sensitivity truth table); orientBudget bounds the local reads; and THE QUERY-CONSTRUCTION
// GUARD — buildOrientedQuery can never emit a verbatim KB-dump query (the D6a/D8 security boundary).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendAuditEvent } from './audit';
import { orient, buildOrientedQuery, chooseAngle, clampAngle, ORIENT_ANGLE_MAX_CHARS, type NeighborhoodReader, type OrientGate } from './researchOrient';
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

// A fake gate shaped like DEV-2's sensitivityAllowsOrientRead (D6 map): public-web → only shareable(0);
// internal-tenant → ≤ confidential(2); local-only → any. 'internal' is rank 1.
const rank = (s: string): number => ({ shareable: 0, internal: 1, confidential: 2 })[s] ?? 3;
const fakeGate: OrientGate = (tier, sensitivity) => {
  const max = { 'public-web': 0, 'internal-tenant': 2, 'local-only': 3 }[tier];
  return rank(sensitivity) <= max;
};
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
      const res = await orient(root, web({ orientBudget: 5 }), reqOf('Project Atlas'), { readNeighborhood: reader(), gate: fakeGate, now: () => '2026-01-15T00:00:00.000Z' });
      expect(res.dedupSet.has('https://arxiv.org/abs/1')).toBe(true); // result-level dedup (RESEARCH-21)
      expect(res.floor).toEqual(['Benchmark Suite', 'Rival Corp']); // structural floor (names)
      expect(res.angle.length).toBeGreaterThan(0); // a fresh gap was chosen
      expect(res.angle.length).toBeLessThanOrEqual(ORIENT_ANGLE_MAX_CHARS);
    });
  });

  it('CONTENT read is gated by sensitivity↔tier — public-web floor-only, internal-tenant reads content', async () => {
    await withTemp(async (root) => {
      const pub = await orient(root, web({ id: 'web-1', egressTier: 'public-web', orientBudget: 5 }), reqOf('X'), { readNeighborhood: reader(), gate: fakeGate });
      expect(pub.contentRead).toBe(false); // public-web + unlabeled('internal') → gate denies content; floor only
      const internal = await orient(root, web({ id: 'web-1', egressTier: 'internal-tenant', orientBudget: 5 }), reqOf('X'), { readNeighborhood: reader(), gate: fakeGate });
      expect(internal.contentRead).toBe(true); // internal-tenant → gate permits content
    });
  });

  it('orientBudget bounds the local reads (a tiny budget stops before the neighborhood/content reads)', async () => {
    await withTemp(async (root) => {
      const res = await orient(root, web({ egressTier: 'local-only', orientBudget: 1 }), reqOf('X'), { readNeighborhood: reader(), gate: fakeGate });
      expect(res.reads).toBeLessThanOrEqual(1); // budget 1 → only the notebook read; no neighborhood/content
      expect(res.floor).toEqual([]); // never reached the structural-floor read
    });
  });
});
