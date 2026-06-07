// SPEC-0042 EVAL Slice-2 — reproducibility manifest (EVAL-9). Pure — runs in CI.
import { describe, it, expect, afterEach } from 'vitest';
import { buildManifest } from './manifest';
import { DEFAULT_JUDGE_MODEL } from './judge';

afterEach(() => {
  delete process.env.KB_COPILOT_MODEL;
  delete process.env.KB_EVAL_JUDGE_MODEL;
});

describe('buildManifest (EVAL-9)', () => {
  it('records SUT model (env/default), pinned judge model, prompt versions, node, timestamp', () => {
    process.env.KB_COPILOT_MODEL = 'sut-x';
    const m = buildManifest('enrich-hopper', 'model=sut-x', '2026-06-07T00:00:00.000Z');
    expect(m).toMatchObject({ scenarioId: 'enrich-hopper', variant: 'model=sut-x', sutModel: 'sut-x', judgeModel: DEFAULT_JUDGE_MODEL, at: '2026-06-07T00:00:00.000Z' });
    expect(m.promptVersions.decompose).toMatch(/decompose\//);
    expect(m.node).toBe(process.version);
  });
  it('falls back to the SDK default SUT model when the env is unset', () => {
    delete process.env.KB_COPILOT_MODEL;
    expect(buildManifest('s', 'default', 'T').sutModel).toBe('copilot-default');
  });
});
