// ORCH-16 / model-pin gap: resolveCopilotModel must ALWAYS yield a concrete model so prod never
// runs unpinned (silently inheriting ~/.copilot/settings.json) and traces never record `default`.
import { describe, it, expect } from 'vitest';
import { resolveCopilotModel, DEFAULT_COPILOT_MODEL, isModelUnavailableError, COPILOT_MODEL_AUTO } from './copilotModel';

describe('resolveCopilotModel (ORCH-16 model pin)', () => {
  it('pins the in-app default when KB_COPILOT_MODEL is unset (the prod path that was broken)', () => {
    expect(resolveCopilotModel({})).toBe(DEFAULT_COPILOT_MODEL);
  });

  it('uses the explicit KB_COPILOT_MODEL override when set (the eval-harness path)', () => {
    expect(resolveCopilotModel({ KB_COPILOT_MODEL: 'claude-sonnet-4' })).toBe('claude-sonnet-4');
  });

  it('treats an empty / whitespace-only override as unset and falls back to the pin', () => {
    expect(resolveCopilotModel({ KB_COPILOT_MODEL: '' })).toBe(DEFAULT_COPILOT_MODEL);
    expect(resolveCopilotModel({ KB_COPILOT_MODEL: '   ' })).toBe(DEFAULT_COPILOT_MODEL);
  });

  it('never returns undefined or the literal "default" — the launch is always concrete', () => {
    const resolved = resolveCopilotModel({});
    expect(resolved).toBeTruthy();
    expect(resolved).not.toBe('default');
  });

  it('the pinned default is a copilot-CLI-valid model id (claude-opus-4 was rejected pre-flight)', () => {
    expect(DEFAULT_COPILOT_MODEL).toBe('claude-opus-4.5');
  });
});

describe('isModelUnavailableError (the pre-flight model-rejection the auto-fallback recovers from)', () => {
  it('matches copilot CLI message on err.message', () => {
    expect(isModelUnavailableError(new Error('Error: Model "claude-opus-4" from --model flag is not available.'))).toBe(true);
  });

  it('matches when the rejection is on err.stderr (how execFile surfaces it)', () => {
    const err = Object.assign(new Error('Command failed'), { stderr: 'Model "claude-opus-4" from --model flag is not available.' });
    expect(isModelUnavailableError(err)).toBe(true);
  });

  it('matches a tolerant "model ... not available" wording variant', () => {
    expect(isModelUnavailableError(new Error('the requested model is not available'))).toBe(true);
  });

  it('does NOT match unrelated failures — auth / network / parse / ENOENT (no spurious model swap)', () => {
    expect(isModelUnavailableError(new Error('ENOENT: copilot not found'))).toBe(false);
    expect(isModelUnavailableError(new Error('401 Unauthorized'))).toBe(false);
    expect(isModelUnavailableError(new Error('no JSON object in output'))).toBe(false);
    expect(isModelUnavailableError(new Error('network timeout'))).toBe(false);
  });

  it('is null/undefined-safe', () => {
    expect(isModelUnavailableError(null)).toBe(false);
    expect(isModelUnavailableError(undefined)).toBe(false);
    expect(isModelUnavailableError('a bare string')).toBe(false);
  });

  it('the fallback model is `auto` (CLI-verified accepted)', () => {
    expect(COPILOT_MODEL_AUTO).toBe('auto');
  });
});
