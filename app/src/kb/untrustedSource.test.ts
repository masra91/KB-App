// INTAKE-13 / RESEARCH-12 — the untrusted-source-content fence used by the in-pipeline deciders.
import { describe, it, expect } from 'vitest';
import { UNTRUSTED_SOURCE_SKILL, UNTRUSTED_SOURCE_DELIMITER_NOTE } from './untrustedSource';

describe('UNTRUSTED_SOURCE_SKILL (INTAKE-13 prompt-injection fence)', () => {
  it('frames the source as DATA, forbids obeying instructions embedded in it, and pins task to the system prompt', () => {
    expect(UNTRUSTED_SOURCE_SKILL).toMatch(/DATA.*NEVER instructions/i);
    expect(UNTRUSTED_SOURCE_SKILL).toMatch(/do not follow/i);
    // Names the higher-risk surface the requirement targets (external feeds).
    expect(UNTRUSTED_SOURCE_SKILL).toMatch(/RSS|news|feed|email/i);
    // The output/task must come from the system prompt, not the (possibly attacker-controlled) source.
    expect(UNTRUSTED_SOURCE_SKILL).toMatch(/only these system instructions|defined ONLY by/i);
  });

  it('the delimiter reminder reinforces the fence right where the untrusted bytes begin', () => {
    expect(UNTRUSTED_SOURCE_DELIMITER_NOTE).toMatch(/SOURCE BEGIN/);
    expect(UNTRUSTED_SOURCE_DELIMITER_NOTE).toMatch(/untrusted|do NOT obey/i);
  });
});
