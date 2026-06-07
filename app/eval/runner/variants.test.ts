// SPEC-0042 EVAL Slice-2 — variant matrix (EVAL-7). Pure-ish (only the model env is process-global,
// captured+restored) — runs in CI.
import { describe, it, expect, afterEach } from 'vitest';
import { applyVariant, variantLabel, expandMatrix } from './variants';

afterEach(() => {
  delete process.env.KB_COPILOT_MODEL;
});

describe('applyVariant (model + budget axes; deferred axes fail fast)', () => {
  it('sets KB_COPILOT_MODEL for the model axis and restores the prior value', () => {
    process.env.KB_COPILOT_MODEL = 'prev';
    const rv = applyVariant({ model: 'variant-model' });
    expect(process.env.KB_COPILOT_MODEL).toBe('variant-model');
    expect(rv.label).toBe('model=variant-model');
    rv.restore();
    expect(process.env.KB_COPILOT_MODEL).toBe('prev');
  });
  it('restores to UNSET when there was no prior model', () => {
    delete process.env.KB_COPILOT_MODEL;
    const rv = applyVariant({ model: 'm' });
    rv.restore();
    expect(process.env.KB_COPILOT_MODEL).toBeUndefined();
  });
  it('extracts the budget axis (recall maxToolCalls)', () => {
    expect(applyVariant({ budget: { maxToolCalls: 25 } }).recallMaxToolCalls).toBe(25);
  });
  it('FAILS FAST on the deferred promptVersion/toolConfig axes', () => {
    expect(() => applyVariant({ promptVersion: 'decompose/v3' })).toThrow(/deferred/);
    expect(() => applyVariant({ toolConfig: {} })).toThrow(/deferred/);
  });
  it('the empty variant is labelled "default"', () => {
    expect(variantLabel({})).toBe('default');
  });
});

describe('expandMatrix', () => {
  it('returns the declared variants, or a single default when none', () => {
    expect(expandMatrix(undefined)).toEqual([{}]);
    expect(expandMatrix([])).toEqual([{}]);
    expect(expandMatrix([{ model: 'a' }, { model: 'b' }])).toHaveLength(2);
  });
});
