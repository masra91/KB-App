// Reflect decider prompt + parse (SPEC-0024 REFLECT-3). Pure functions, no copilot/FS.
import { describe, it, expect } from 'vitest';
import { buildReflectPrompt, parseReflectResult, makeReflectDecider, type ReflectContext } from './reflectAgent';

const ctx: ReflectContext = {
  workingSet: [{ rel: 'entities/person/steve.md', name: 'Steve', kind: 'person', tags: ['type/person'], excerpt: 'Founder.' }],
  journalNotes: ['2026-06-01T00:00:00Z: reflect: …'],
};

describe('buildReflectPrompt', () => {
  it('includes the working set, journal continuity, and the growth-bias / no-fabrication rules', () => {
    const p = buildReflectPrompt(ctx);
    expect(p).toContain('entities/person/steve.md');
    expect(p).toContain('Bias toward GROWTH');
    expect(p).toContain('NOT the whole KB');
    expect(p).toContain('"inspected"'); // the required JSON shape
  });
});

describe('parseReflectResult', () => {
  it('parses additive findings with writes and destructive findings with a review', () => {
    const out = JSON.stringify({
      inspected: 'looked at Steve',
      findings: [
        { summary: 'missed claim', kind: 'additive', confidence: 0.9, writes: [{ rel: 'claims/x.md', content: 'c' }] },
        { summary: 'merge dupes', kind: 'destructive', confidence: 0.6, review: { question: 'Merge A and B?', detail: 'both "Steve"' } },
      ],
    });
    const r = parseReflectResult(`prose… ${out} …trailing`);
    expect(r.inspected).toBe('looked at Steve');
    expect(r.findings[0]).toMatchObject({ kind: 'additive', writes: [{ rel: 'claims/x.md', content: 'c' }] });
    expect(r.findings[1]).toMatchObject({ kind: 'destructive', review: { question: 'Merge A and B?' } });
  });

  it('accepts an empty findings array (a no-find pass is valid; REFLECT-6)', () => {
    expect(parseReflectResult('{"inspected":"nothing","findings":[]}').findings).toEqual([]);
  });

  it('throws (no fabrication) on a bad shape', () => {
    expect(() => parseReflectResult('no json here')).toThrow(/no JSON/);
    expect(() => parseReflectResult('{"inspected":"x"}')).toThrow(/findings must be an array/);
    expect(() => parseReflectResult('{"inspected":"x","findings":[{"summary":"s","kind":"weird","confidence":1}]}')).toThrow(/kind must be/);
    expect(() => parseReflectResult('{"inspected":"x","findings":[{"summary":"s","kind":"additive","confidence":2}]}')).toThrow(/confidence/);
    expect(() => parseReflectResult('{"inspected":"x","findings":[{"summary":"s","kind":"additive","confidence":1,"writes":[{"rel":"r"}]}]}')).toThrow(/writes/);
  });
});

describe('makeReflectDecider', () => {
  it('runs the injected runner and parses its output (no copilot shell-out in tests)', async () => {
    const decider = makeReflectDecider({ available: true, run: async () => '{"inspected":"ran","findings":[]}' });
    expect(await decider(ctx)).toEqual({ inspected: 'ran', findings: [] });
  });

  it('throws when copilot is unavailable (no fabrication)', async () => {
    const decider = makeReflectDecider({ available: false });
    await expect(decider(ctx)).rejects.toThrow(/unavailable/);
  });
});
