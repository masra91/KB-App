// Researcher run pass (SPEC-0028 RESEARCH-5/6/8/12). Real FS+git temp vault (TEST-18); the cognition
// (external research) is injected deterministically — no network/SDK.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { readCapturedMeta } from './ingest';
import { runResearcher, buildOutboundQuery, MAX_OUTBOUND_CONTEXT_CHARS, type ResearchFn } from './researchRun';
import { CONTROL_AUDIT_REL } from './audit';
import type { ResearcherConfig, ResearchRequest } from './researchers';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    await fn(root);
  } finally {
    await rmTempDir(dir);
  }
}

const web: ResearcherConfig = { id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true };
const request: ResearchRequest = { id: 'req-1', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose', sourceId: 'S1', entityId: 'E1' }, what: 'Project Atlas', why: 'unknown term', context: 'launch codename', dedupKey: 'project atlas::E1' };

async function readAudit(root: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(path.join(root, CONTROL_AUDIT_REL), 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('buildOutboundQuery — request-only egress (RESEARCH-8 / D6a)', () => {
  it('builds the query from the request what/context ONLY (no KB content)', () => {
    expect(buildOutboundQuery(request)).toBe('Project Atlas — launch codename');
    expect(buildOutboundQuery({ ...request, context: '' })).toBe('Project Atlas');
  });

  it('HARD-CAPS context to MAX_OUTBOUND_CONTEXT_CHARS so unbounded source text cannot leak (KB-QD #96)', () => {
    const huge = 'x'.repeat(MAX_OUTBOUND_CONTEXT_CHARS + 5000);
    const q = buildOutboundQuery({ ...request, context: huge });
    const ctxPart = q.slice('Project Atlas — '.length);
    expect(ctxPart.length).toBe(MAX_OUTBOUND_CONTEXT_CHARS + 1); // capped slice + the single ellipsis
    expect(ctxPart.endsWith('…')).toBe(true);
    expect(q.length).toBeLessThan(huge.length); // the blob never rides outbound in full
  });

  it('leaves a within-bound context untouched (no spurious truncation)', () => {
    expect(buildOutboundQuery({ ...request, context: 'launch codename' })).toBe('Project Atlas — launch codename');
  });
});

describe.skipIf(!gitAvailable)('runResearcher (RESEARCH-5/6)', () => {
  it('on a finding: writes a cited secondary source + emits a researched audit event', async () => {
    await withVault(async (root) => {
      const research: ResearchFn = async () => ({ found: true, note: 'Atlas is a launch codename per the press release. [1]', citations: ['https://example.com/atlas'], query: 'Project Atlas' });
      const res = await runResearcher(root, web, request, { research, now: () => '2026-06-02T01:00:00.000Z' });

      expect(res.sourceIds).toHaveLength(1);
      // the secondary source is on disk with origin + citation-rich provenance (RESEARCH-6).
      const meta = await readCapturedMeta(path.join(root, 'inbox', res.sourceIds[0]));
      expect(meta.origin).toBe('secondary');
      expect(meta.research).toMatchObject({ researcherId: 'web-1', requestId: 'req-1', citations: ['https://example.com/atlas'] });

      const audit = await readAudit(root);
      const ev = audit.find((a) => a.eventType === 'researched')!;
      expect(ev).toMatchObject({ actor: 'researcher' });
      expect((ev.subjects as Record<string, unknown>).researcherId).toBe('web-1');
      expect((ev.payload as Record<string, unknown>).externallySourced).toBe(true);
    });
  });

  it('on no finding: writes no source but audits the no-op (RESEARCH-4, no silent action)', async () => {
    await withVault(async (root) => {
      const research: ResearchFn = async () => ({ found: false, note: '', citations: [], query: 'Project Atlas' });
      const res = await runResearcher(root, web, request, { research });
      expect(res.sourceIds).toEqual([]);
      const audit = await readAudit(root);
      expect(audit.some((a) => a.eventType === 'no-finding' && a.actor === 'researcher')).toBe(true);
    });
  });

  it('refuses an unsafe researcher id before touching any path (defense-in-depth)', async () => {
    await withVault(async (root) => {
      const research: ResearchFn = async () => ({ found: true, note: 'x', citations: [], query: 'q' });
      await expect(runResearcher(root, { ...web, id: '../evil' }, request, { research })).rejects.toThrow(/unsafe researcher id/);
    });
  });

  it('the global per-Instance ceiling refuses a pass past the cap — NO egress + a ceiling-reached no-op (RESEARCH-11)', async () => {
    await withVault(async (root) => {
      let calls = 0;
      const research: ResearchFn = async () => {
        calls++;
        return { found: true, note: 'a finding', citations: [], query: 'q' };
      };
      // ceiling=1: the first pass egresses + is recorded; the second is refused BEFORE the cognition runs.
      const r1 = await runResearcher(root, web, request, { research, instanceCeiling: 1, now: () => '2026-06-02T01:00:00.000Z' });
      const r2 = await runResearcher(root, web, { ...request, id: 'req-2' }, { research, instanceCeiling: 1, now: () => '2026-06-02T01:05:00.000Z' });
      expect(calls).toBe(1); // the 2nd pass never reached egress — the hard backstop, not advisory
      expect(r1.sourceIds).toHaveLength(1);
      expect(r1.ceilingReached).toBeUndefined(); // an admitted pass is NOT flagged ceiling
      expect(r2.sourceIds).toEqual([]);
      expect(r2.ceilingReached).toBe(true); // distinguishable from a legit no-finding (ceiling ≠ empty)
      expect(r2.note).toMatch(/ceiling reached/i);
      const audit = await readAudit(root);
      const ceiling = audit.find((a) => a.eventType === 'ceiling-reached');
      expect(ceiling, 'a refused pass must audit ceiling-reached (no silent action)').toBeDefined();
      expect(ceiling!.actor).toBe('researcher');
      expect((ceiling!.payload as Record<string, unknown>).ceiling).toBe(1);
    });
  });

  it('a FAILED pass audits `research-failed` (not the silent `no-finding`) so failed≠empty (#160)', async () => {
    await withVault(async (root) => {
      // The cognition reports failure (e.g. packaged-app can't spawn copilot) — distinct from a no-finding.
      const research: ResearchFn = async () => ({ found: false, note: '', citations: [], query: 'Project Atlas', failed: true, error: 'spawn copilot ENOENT' });
      const res = await runResearcher(root, web, request, { research, now: () => '2026-06-02T01:00:00.000Z' });
      expect(res.sourceIds).toEqual([]);
      expect(res.failed).toBe(true);
      expect(res.error).toMatch(/ENOENT/);
      const audit = await readAudit(root);
      const failed = audit.find((a) => a.eventType === 'research-failed');
      expect(failed, 'a failure must emit research-failed').toBeDefined();
      expect(failed!.actor).toBe('researcher');
      expect((failed!.payload as Record<string, unknown>).error).toMatch(/ENOENT/);
      // and it must NOT be miscounted as a legit no-finding (the bug that hid this).
      expect(audit.some((a) => a.eventType === 'no-finding')).toBe(false);
    });
  });
});

describe.skipIf(!gitAvailable)('runResearcher — warm-start orient integration (RESEARCH-21/22)', () => {
  it('runs orient BEFORE egress, folds its angle into the research request, and is non-egress (separate from the fetch counter)', async () => {
    await withVault(async (root) => {
      const order: string[] = [];
      let receivedContext = '';
      // The orient dep (opaque to runResearcher): returns the request with an angle folded into context +
      // a separate `reads` count. It must run BEFORE the egress research call.
      const orientDep = async (_r: ResearcherConfig, req: ResearchRequest): Promise<{ orientedReq: ResearchRequest; reads: number; angle: string }> => {
        order.push('orient');
        return { orientedReq: { ...req, context: `${req.context} · benchmark numbers` }, reads: 3, angle: 'benchmark numbers' };
      };
      const research: ResearchFn = async (_r, req) => {
        order.push('research');
        receivedContext = req.context; // the egress pass sees the ORIENTED context
        return { found: true, note: 'finding', citations: ['https://x.com/1'], query: buildOutboundQuery(req) };
      };
      const res = await runResearcher(root, web, request, { research, orient: orientDep, now: () => '2026-06-02T00:00:00.000Z' });
      expect(res.sourceIds.length).toBe(1);
      // Orient ran first; the egress research call is the ONLY pass (orient is non-egress — it never calls
      // research, so it can't increment the egress fetch counter; the egress pass runs exactly once).
      expect(order).toEqual(['orient', 'research']);
      expect(order.filter((s) => s === 'research')).toHaveLength(1);
      // The orient-chosen angle reached the egress query through the request context.
      expect(receivedContext).toContain('benchmark numbers');
    });
  });

  it('refreshes the field notebook after a successful pass (RESEARCH-21 — next orient sees the harvested source)', async () => {
    await withVault(async (root) => {
      const { readNotebook } = await import('./researchNotebook');
      const research: ResearchFn = async (_r, req) => ({ found: true, note: 'finding', citations: ['https://arxiv.org/abs/9'], query: req.what });
      await runResearcher(root, web, request, { research, now: () => '2026-06-02T00:00:00.000Z' });
      const nb = await readNotebook(root, 'web-1');
      // The notebook (derived from the just-written `researched` audit) now carries the harvested source.
      expect(nb.harvested.some((s) => s.url === 'https://arxiv.org/abs/9')).toBe(true);
      expect(nb.areas.length).toBeGreaterThan(0); // the drilled area is recorded
    });
  });

  it('orient is best-effort — a thrown orient never blocks the egress pass (degrades to cold)', async () => {
    await withVault(async (root) => {
      const research: ResearchFn = async (_r, req) => ({ found: true, note: 'finding', citations: [], query: req.what });
      const orientDep = async (): Promise<never> => {
        throw new Error('orient boom');
      };
      const res = await runResearcher(root, web, request, { research, orient: orientDep, now: () => '2026-06-02T00:00:00.000Z' });
      expect(res.sourceIds.length).toBe(1); // the pass still produced a finding despite orient throwing
    });
  });

  it('RMEM-2: a successful pass records a durable run in the ledger (target/facet/angle/harvested/outcome)', async () => {
    await withVault(async (root) => {
      const { readLedger } = await import('./researchLedger');
      const reqWithGap: ResearchRequest = { ...request, gap: { present: [], missing: ['founding date', 'leadership'] } };
      const orientDep = async (_r: ResearcherConfig, req: ResearchRequest): Promise<{ orientedReq: ResearchRequest; reads: number; angle: string }> => ({ orientedReq: req, reads: 1, angle: 're Project Atlas: founding date' });
      const research: ResearchFn = async (_r, req) => ({ found: true, note: 'finding', citations: ['https://x.com/1'], query: req.what });
      const res = await runResearcher(root, web, reqWithGap, { research, orient: orientDep, now: () => '2026-06-02T00:00:00.000Z' });

      const ledger = await readLedger(root, 'web-1');
      expect(ledger.runs).toHaveLength(1);
      expect(ledger.runs[0]).toMatchObject({ target: 'Project Atlas', entityId: 'E1', gapFacet: 'founding date', angle: 're Project Atlas: founding date', outcome: 'finding' });
      expect(ledger.runs[0].harvested).toEqual(res.sourceIds); // the produced source id is remembered
    });
  });

  it('RMEM-3: a no-finding pass is still recorded (drilled), but a FAILED pass does not suppress a retry', async () => {
    await withVault(async (root) => {
      const { readLedger, coveredAngles } = await import('./researchLedger');
      const reqWithGap: ResearchRequest = { ...request, gap: { present: [], missing: ['founding date'] } };
      const orientDep = async (_r: ResearcherConfig, req: ResearchRequest): Promise<{ orientedReq: ResearchRequest; reads: number; angle: string }> => ({ orientedReq: req, reads: 1, angle: 're Project Atlas: founding date' });
      const noFind: ResearchFn = async (_r, req) => ({ found: false, note: '', citations: [], query: req.what });
      await runResearcher(root, web, reqWithGap, { research: noFind, orient: orientDep, now: () => '2026-06-02T00:00:00.000Z' });
      const failPass: ResearchFn = async (_r, req) => ({ found: false, note: '', citations: [], query: req.what, failed: true, error: 'spawn ENOENT' });
      await runResearcher(root, web, { ...reqWithGap, id: 'req-2' }, { research: failPass, orient: orientDep, now: () => '2026-06-02T02:00:00.000Z' });

      const ledger = await readLedger(root, 'web-1');
      expect(ledger.runs.map((r) => r.outcome).sort()).toEqual(['failed', 'no-finding']);
      // The no-finding DID drill the facet (excluded); the failed one did not → net: the facet is covered.
      const covered = coveredAngles(ledger, 'Project Atlas', 'E1', Date.parse('2026-06-02T03:00:00.000Z'));
      expect(covered).toEqual(['re Project Atlas: founding date']);
    });
  });
});
