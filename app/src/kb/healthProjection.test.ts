// SPEC-0058 STATE-3/13 — the Health projection transform (DL-2's render contract). Pure unit tests: the
// baked severity policy, overall/totalIssues, dimension order + copy, findings pass-through (incl. malformed
// — ENG-15/16: never dropped here, the view degrades per-item), the empty case, and the status envelopes.
import { describe, it, expect } from 'vitest';
import { toHealthProjection, dimensionSeverity, warmingHealthProjection, unavailableHealthProjection, isDanglingFinding } from './healthProjection';
import type { HealthReport } from './healthPanel';

const report = (over: Partial<HealthReport> = {}): HealthReport => ({
  scanned: 12,
  orphans: [{ rel: 'entities/x/a.md', id: 'a', name: 'A', kind: 'concept' }],
  thin: [{ rel: 'entities/x/b.md', id: 'b', name: 'B', kind: 'person', chars: 40 }],
  dangling: [{ from: 'entities/x/c.md', fromName: 'C', target: 'entities/ghost/z.md' }],
  counts: { orphans: 1, thin: 1, dangling: 1 },
  ...over,
});
const ISO = '2026-06-28T00:00:00.000Z';

describe('dimensionSeverity (baked policy)', () => {
  it('clean → ok; dead links → bad; orphans/thin → warn', () => {
    expect(dimensionSeverity('dangling', 0)).toBe('ok');
    expect(dimensionSeverity('orphans', 0)).toBe('ok');
    expect(dimensionSeverity('dangling', 3)).toBe('bad'); // dead links = broken graph
    expect(dimensionSeverity('orphans', 1)).toBe('warn');
    expect(dimensionSeverity('thin', 5)).toBe('warn');
  });
});

describe('toHealthProjection', () => {
  it('maps the report into the three dimensions in display order with label/desc/severity/count', () => {
    const p = toHealthProjection(report(), ISO);
    expect(p.status).toBe('ready');
    expect(p.scanned).toBe(12);
    expect(p.generatedAt).toBe(ISO);
    expect(p.dimensions.map((d) => d.key)).toEqual(['dangling', 'orphans', 'thin']);
    expect(p.dimensions.map((d) => d.label)).toEqual(['Dead links', 'Orphans', 'Thin pages']);
    expect(p.dimensions.map((d) => d.severity)).toEqual(['bad', 'warn', 'warn']);
    expect(p.dimensions.every((d) => d.desc.length > 0)).toBe(true);
  });

  it('overall = attention when there are issues, ok when none', () => {
    expect(toHealthProjection(report(), ISO).overall).toBe('attention');
    expect(toHealthProjection(report(), ISO).totalIssues).toBe(3);
    const clean = toHealthProjection(report({ orphans: [], thin: [], dangling: [], counts: { orphans: 0, thin: 0, dangling: 0 } }), ISO);
    expect(clean.overall).toBe('ok');
    expect(clean.totalIssues).toBe(0);
    expect(clean.dimensions.every((d) => d.severity === 'ok' && d.findings.length === 0)).toBe(true);
  });

  it('count is the FULL count even when findings are capped (list ≤ count)', () => {
    const p = toHealthProjection(report({ orphans: [{ rel: 'e/a.md', id: 'a', name: 'A', kind: 'c' }], counts: { orphans: 9, thin: 0, dangling: 0 }, thin: [], dangling: [] }), ISO);
    const orphans = p.dimensions.find((d) => d.key === 'orphans')!;
    expect(orphans.count).toBe(9); // the true total
    expect(orphans.findings).toHaveLength(1); // the capped list
  });

  it('passes findings THROUGH unchanged — including a malformed one (ENG-15/16: not dropped here)', () => {
    const p = toHealthProjection(report({ orphans: [{ rel: 'e/a.md', id: 'a', name: '', kind: '' } as HealthReport['orphans'][number]], counts: { orphans: 1, thin: 0, dangling: 0 }, thin: [], dangling: [] }), ISO);
    expect(p.dimensions.find((d) => d.key === 'orphans')!.findings).toHaveLength(1); // the partial row survives
  });

  it('the dangling dimension carries dead-link findings (discriminable from entity findings)', () => {
    const p = toHealthProjection(report(), ISO);
    const dangling = p.dimensions.find((d) => d.key === 'dangling')!;
    expect(isDanglingFinding(dangling.findings[0])).toBe(true);
    const orphans = p.dimensions.find((d) => d.key === 'orphans')!;
    expect(isDanglingFinding(orphans.findings[0])).toBe(false);
  });
});

describe('status envelopes (STATE-9/10)', () => {
  it('warming → calm warming envelope (no issues implied)', () => {
    expect(warmingHealthProjection()).toMatchObject({ status: 'warming', overall: 'ok', totalIssues: 0, dimensions: [] });
  });
  it('unavailable → error envelope', () => {
    expect(unavailableHealthProjection()).toMatchObject({ status: 'unavailable', dimensions: [] });
  });
});
