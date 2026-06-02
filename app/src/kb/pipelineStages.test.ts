// SPEC-0032 §9 / SPEC-0014 — the shared canonical stage order both backend + VIZ frontend import.
import { describe, it, expect } from 'vitest';
import { STAGE_ORDER, isStageId, stageIndex } from './pipelineStages';

describe('pipelineStages (shared canonical order)', () => {
  it('is the canonical Capture→…→Promote order', () => {
    expect([...STAGE_ORDER]).toEqual(['capture', 'archive', 'decompose', 'connect', 'claims', 'promote']);
  });

  it('isStageId narrows known stages + rejects others', () => {
    expect(isStageId('claims')).toBe(true);
    expect(isStageId('promote')).toBe(true);
    expect(isStageId('nope')).toBe(false);
    expect(isStageId('')).toBe(false);
  });

  it('stageIndex orders the pipeline (drives the stepper fill) + is -1 for unknown', () => {
    expect(stageIndex('capture')).toBe(0);
    expect(stageIndex('claims')).toBe(4);
    expect(stageIndex('promote')).toBe(5);
    expect(stageIndex('connect')).toBeLessThan(stageIndex('claims')); // connect before claims
    expect(stageIndex('nope')).toBe(-1);
  });
});
