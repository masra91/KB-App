// ORCH-16 / model-pin gap: resolveCopilotModel must ALWAYS yield a concrete model so prod never
// runs unpinned (silently inheriting ~/.copilot/settings.json) and traces never record `default`.
import { describe, it, expect } from 'vitest';
import { resolveCopilotModel, DEFAULT_COPILOT_MODEL } from './copilotModel';

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

  it('the pinned default is a real model id, not a placeholder', () => {
    expect(DEFAULT_COPILOT_MODEL).toBe('claude-opus-4');
  });
});
