// RMEM (SPEC-0054) — the durable, first-class researcher run-ledger. Covers: persistence round-trip +
// self-healing, append + bounding, the covered-angle exclusion set (RMEM-3, failed-run + staleness rules),
// the frontier resume set (RMEM-4), harvested dedup, the #29 id guard, and the clean-clear primitives
// (RMEM-7 — clearLedger + clearResearchMemory, no graveyard). Real FS against a throwaway temp dir.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readLedger,
  writeLedger,
  appendRun,
  boundLedger,
  ledgerPath,
  clearLedger,
  clearResearchMemory,
  coveredAngles,
  frontierFacets,
  harvestedSourceIds,
  runTupleKey,
  LEDGER_RUNS_CAP,
  type ResearchLedger,
  type RunLedgerEntry,
} from './researchLedger';
import { NOTEBOOK_STALE_MS } from './researchNotebook';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-ledger-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
const run = (over: Partial<RunLedgerEntry> = {}): RunLedgerEntry => ({ target: 'Ada Lovelace', entityId: 'ent-ada', angle: 're Ada Lovelace: education', gapFacet: 'education', harvested: ['SRC1'], outcome: 'finding', ts: 1000, ...over });

describe('readLedger / writeLedger round-trip (self-healing, durable)', () => {
  it('writes then reads back; missing/corrupt → empty (never throws)', async () => {
    await withTemp(async (root) => {
      expect(await readLedger(root, 'web-1')).toEqual({ researcherId: 'web-1', runs: [] });
      const led: ResearchLedger = { researcherId: 'web-1', runs: [run()] };
      await writeLedger(root, led);
      expect(await readLedger(root, 'web-1')).toEqual(led);
      await fs.writeFile(ledgerPath(root, 'web-1'), 'not json');
      expect(await readLedger(root, 'web-1')).toEqual({ researcherId: 'web-1', runs: [] });
    });
  });
  it('refuses to write under an unsafe researcher id (#29)', async () => {
    await withTemp(async (root) => {
      await expect(writeLedger(root, { researcherId: '../evil', runs: [] })).rejects.toThrow(/unsafe/);
    });
  });
  it('DURABILITY: a written ledger is re-read intact (survives a fresh read = a restart)', async () => {
    await withTemp(async (root) => {
      await appendRun(root, 'web-1', run({ ts: 1 }));
      await appendRun(root, 'web-1', run({ ts: 2, angle: 're Ada Lovelace: date of birth', gapFacet: 'date of birth' }));
      // A brand-new readLedger call (no in-memory state) returns both runs — durable on disk (RMEM-2).
      const reread = await readLedger(root, 'web-1');
      expect(reread.runs.map((r) => r.gapFacet).sort()).toEqual(['date of birth', 'education']);
    });
  });
});

describe('appendRun + boundLedger', () => {
  it('appends newest-first and caps at LEDGER_RUNS_CAP (newest kept)', async () => {
    await withTemp(async (root) => {
      for (let i = 0; i < LEDGER_RUNS_CAP + 25; i++) await appendRun(root, 'web-1', run({ ts: i, angle: `a${i}` }));
      const led = await readLedger(root, 'web-1');
      expect(led.runs.length).toBe(LEDGER_RUNS_CAP);
      expect(led.runs[0].ts).toBe(LEDGER_RUNS_CAP + 24); // newest kept
      expect(led.runs.some((r) => r.ts === 0)).toBe(false); // oldest dropped
    });
  });
  it('boundLedger is pure + sorts newest-first', () => {
    const out = boundLedger({ researcherId: 'x', runs: [run({ ts: 1 }), run({ ts: 3 }), run({ ts: 2 })] });
    expect(out.runs.map((r) => r.ts)).toEqual([3, 2, 1]);
  });
});

describe('coveredAngles (RMEM-3 exclusion set)', () => {
  const led = (runs: RunLedgerEntry[]): ResearchLedger => ({ researcherId: 'web-1', runs });
  it('returns the drilled angles for the matching target, deduped', () => {
    const l = led([run({ angle: 'A' }), run({ angle: 'B' }), run({ angle: 'A' })]);
    expect(coveredAngles(l, 'Ada Lovelace', 'ent-ada', 2000).sort()).toEqual(['A', 'B']);
  });
  it('a FAILED run does NOT suppress its facet (so an egress error retries)', () => {
    const l = led([run({ angle: 'A', outcome: 'failed' })]);
    expect(coveredAngles(l, 'Ada Lovelace', 'ent-ada', 2000)).toEqual([]);
  });
  it('a STALE run ages out (re-opens the facet)', () => {
    const l = led([run({ angle: 'A', ts: 1000 })]);
    expect(coveredAngles(l, 'Ada Lovelace', 'ent-ada', 1000 + NOTEBOOK_STALE_MS + 1)).toEqual([]);
    expect(coveredAngles(l, 'Ada Lovelace', 'ent-ada', 1500)).toEqual(['A']); // fresh → excluded
  });
  it('a different target does not bleed in', () => {
    const l = led([run({ target: 'Other', entityId: 'ent-x', angle: 'A' })]);
    expect(coveredAngles(l, 'Ada Lovelace', 'ent-ada', 2000)).toEqual([]);
  });
});

describe('frontierFacets (RMEM-4 resume set) + harvested + tuple key', () => {
  it('returns the still-missing facets not yet drilled (resume where it stopped)', () => {
    const l: ResearchLedger = { researcherId: 'web-1', runs: [run({ angle: 're Ada Lovelace: education', gapFacet: 'education' })] };
    const missing = ['education', 'date of birth', 'notable work'];
    expect(frontierFacets(l, 'Ada Lovelace', 'ent-ada', missing, 1500)).toEqual(['date of birth', 'notable work']);
  });
  it('harvestedSourceIds unions across runs', () => {
    const l: ResearchLedger = { researcherId: 'web-1', runs: [run({ harvested: ['S1', 'S2'] }), run({ harvested: ['S2', 'S3'] })] };
    expect(harvestedSourceIds(l)).toEqual(new Set(['S1', 'S2', 'S3']));
  });
  it('runTupleKey is stable + facet/angle-normalized', () => {
    expect(runTupleKey({ target: 'Ada Lovelace', entityId: 'ent-ada', gapFacet: 'Education', angle: 'RE Ada: education' }))
      .toBe(runTupleKey({ target: 'ada   lovelace', entityId: 'ent-ada', gapFacet: 'education', angle: 're ada: education' }));
  });
});

describe('clearLedger / clearResearchMemory (RMEM-7 no graveyard)', () => {
  it('clearLedger removes just the ledger file, idempotently', async () => {
    await withTemp(async (root) => {
      await appendRun(root, 'web-1', run());
      await clearLedger(root, 'web-1');
      expect(await readLedger(root, 'web-1')).toEqual({ researcherId: 'web-1', runs: [] });
      await clearLedger(root, 'web-1'); // idempotent — no throw on absent
    });
  });
  it('clearResearchMemory removes the whole .kb/research/<id>/ dir; id-guarded', async () => {
    await withTemp(async (root) => {
      await appendRun(root, 'web-1', run());
      const dir = path.dirname(ledgerPath(root, 'web-1'));
      expect(await fs.stat(dir).then(() => true).catch(() => false)).toBe(true);
      await clearResearchMemory(root, 'web-1');
      expect(await fs.stat(dir).then(() => true).catch(() => false)).toBe(false);
      await expect(clearResearchMemory(root, '../evil')).rejects.toThrow(/unsafe/);
    });
  });
});
