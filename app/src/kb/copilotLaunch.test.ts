import { describe, it, expect, vi } from 'vitest';
import { runWithModelFallback } from './copilotLaunch';
import { DEFAULT_COPILOT_MODEL, COPILOT_MODEL_AUTO } from './copilotModel';

// A copilot pre-flight model-rejection, as execFile surfaces it (message carries the CLI's stderr).
const modelRejected = () => new Error('Error: Model "claude-opus-4" from --model flag is not available.');

describe('runWithModelFallback (model-pin resilience — ORCH-16 fast-follow)', () => {
  it('launches with the pinned model and does NOT fall back when it succeeds', async () => {
    const attempt = vi.fn(async (_model: string) => 'ok');
    const onFallback = vi.fn();
    const out = await runWithModelFallback(attempt, { env: {} as NodeJS.ProcessEnv, onFallback });
    expect(out).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith(DEFAULT_COPILOT_MODEL); // the in-app pin
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back to `auto` exactly ONCE when the pinned model is rejected pre-flight', async () => {
    const attempt = vi.fn(async (model: string) => {
      if (model === DEFAULT_COPILOT_MODEL) throw modelRejected();
      return `ran-on:${model}`;
    });
    const onFallback = vi.fn();
    const out = await runWithModelFallback(attempt, { env: {} as NodeJS.ProcessEnv, onFallback });
    expect(out).toBe(`ran-on:${COPILOT_MODEL_AUTO}`); // the retry's result
    expect(attempt.mock.calls.map((c) => c[0])).toEqual([DEFAULT_COPILOT_MODEL, COPILOT_MODEL_AUTO]); // pinned, then auto
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(DEFAULT_COPILOT_MODEL, COPILOT_MODEL_AUTO);
  });

  it('does NOT retry on a non-model error — it propagates (no masking a real failure)', async () => {
    const attempt = vi.fn(async (_model: string) => {
      throw new Error('ENOENT: copilot not found');
    });
    const onFallback = vi.fn();
    await expect(runWithModelFallback(attempt, { env: {} as NodeJS.ProcessEnv, onFallback })).rejects.toThrow(/ENOENT/);
    expect(attempt).toHaveBeenCalledTimes(1); // tried once, no auto-retry
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('honors KB_COPILOT_MODEL as the pinned model for the first attempt (eval override)', async () => {
    const attempt = vi.fn(async (_model: string) => 'ok');
    await runWithModelFallback(attempt, { env: { KB_COPILOT_MODEL: 'gpt-5.5' } as NodeJS.ProcessEnv });
    expect(attempt).toHaveBeenCalledWith('gpt-5.5');
  });

  it('propagates a rejection on the `auto` retry too (single retry, not a loop)', async () => {
    const attempt = vi.fn(async (_model: string) => {
      throw modelRejected(); // even `auto` "rejected" → surfaces, never loops
    });
    await expect(runWithModelFallback(attempt, { env: {} as NodeJS.ProcessEnv })).rejects.toThrow(/not available/);
    expect(attempt).toHaveBeenCalledTimes(2); // pinned + one auto retry, then give up
  });
});
