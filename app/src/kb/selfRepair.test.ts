// SPEC-0049 HEAL-1 — the self-repair round. These pin the convergence behaviour AND the #256 boundary
// (an attempt() failure is NOT repaired — it propagates so the orchestrator's breaker still trips).
import { describe, it, expect, vi } from 'vitest';
import { runWithSelfRepair, appendRepairInstruction } from './selfRepair';

describe('runWithSelfRepair (HEAL-1)', () => {
  it('parses on the first try → repairs: 0, attempt called once with no repair hint', async () => {
    const attempt = vi.fn(async () => '{"ok":true}');
    const { value, repairs } = await runWithSelfRepair(attempt, (s) => JSON.parse(s));
    expect(value).toEqual({ ok: true });
    expect(repairs).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith(null);
  });

  it('re-prompts with the error fed back and converges → repairs: 1', async () => {
    const attempt = vi
      .fn<(r: unknown) => Promise<string>>()
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce('{"fixed":true}');
    const onRepair = vi.fn();
    const { value, repairs } = await runWithSelfRepair(attempt, (s) => JSON.parse(s), { onRepair });
    expect(value).toEqual({ fixed: true });
    expect(repairs).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    // the second call carries the repair hint (the error + the prior raw)
    const hint = attempt.mock.calls[1][0] as { error: string; priorRaw: string };
    expect(hint.priorRaw).toBe('not json at all');
    expect(hint.error).toMatch(/JSON|Unexpected|token/i);
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it('throws the LAST parse error after the bounded budget is exhausted (un-repairable item)', async () => {
    const attempt = vi.fn(async () => 'still not json');
    await expect(runWithSelfRepair(attempt, () => { throw new Error('validation: bad shape'); }, { maxRepairs: 1 })).rejects.toThrow(
      /validation: bad shape/,
    );
    expect(attempt).toHaveBeenCalledTimes(2); // first + one repair, then give up
  });

  it('clamps maxRepairs to at most 2 rounds', async () => {
    const attempt = vi.fn(async () => 'never valid');
    await expect(runWithSelfRepair(attempt, () => { throw new Error('nope'); }, { maxRepairs: 99 })).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(3); // first + 2 repairs (clamped), never more
  });

  it('HEAL-6 boundary: an attempt() failure is NOT repaired — it propagates immediately', async () => {
    // A launch/timeout/systemic error surfaces from attempt(), not parse() — self-repair must not swallow
    // it (else the #256 wedged-writer breaker would never trip). parse() is never reached.
    const attempt = vi.fn(async () => { throw new Error('copilot: launch failed (systemic)'); });
    const parse = vi.fn((s: string) => JSON.parse(s));
    await expect(runWithSelfRepair(attempt, parse)).rejects.toThrow(/launch failed \(systemic\)/);
    expect(attempt).toHaveBeenCalledTimes(1); // no repair round — propagated on the first attempt
    expect(parse).not.toHaveBeenCalled();
  });

  it('a failure on the repair attempt itself also propagates (not retried again)', async () => {
    const attempt = vi
      .fn<(r: unknown) => Promise<string>>()
      .mockResolvedValueOnce('bad json')
      .mockRejectedValueOnce(new Error('copilot: timeout on repair round'));
    await expect(runWithSelfRepair(attempt, (s) => JSON.parse(s))).rejects.toThrow(/timeout on repair round/);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('appendRepairInstruction (HEAL-1)', () => {
  it('appends the validator error and the prior raw output to the base prompt', () => {
    const out = appendRepairInstruction('BASE PROMPT', { error: 'connect: covers 4 of 5 candidates', priorRaw: '{"clusters":[]}' });
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('connect: covers 4 of 5 candidates');
    expect(out).toContain('{"clusters":[]}');
    expect(out).toMatch(/corrected JSON/i);
  });

  it('bounds an oversized prior-raw feedback so the repair prompt stays sane', () => {
    const huge = 'x'.repeat(20_000);
    const out = appendRepairInstruction('BASE', { error: 'too big', priorRaw: huge });
    expect(out).toContain('…(truncated)');
    expect(out.length).toBeLessThan(huge.length); // not the full 20k echoed back
  });
});
