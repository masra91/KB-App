// SPEC-0030 OBS-17 — the pure, stage-agnostic recovery-action planner behind `kb:pipelineControl`.
import { describe, it, expect } from 'vitest';
import { planSetAsideAction, type SetAsideTarget } from './pipelineControl';
import type { PipelineControlRequest } from './types';

// Targets are pre-resolved by the caller (pipeline.ts) per stage: claims → {id:entityId, handle:entityRel},
// connect → {id:blockKey, handle:blockKey}. The planner is stage-agnostic — it only sees id/handle/label.
const CLAIMS: SetAsideTarget[] = [
  { id: '01ADAID', handle: 'entities/people/01ADAID.md', label: 'Ada Lovelace' },
  { id: '01NONAME', handle: 'entities/people/01NONAME.md', label: '01NONAME' },
];
const CONNECT: SetAsideTarget[] = [
  { id: 'block:engine', handle: 'block:engine', label: 'Analytical Engine' },
];
const req = (over: Partial<PipelineControlRequest>): PipelineControlRequest => ({ action: 'retry', stage: 'claims', itemId: '01ADAID', ...over });

describe('planSetAsideAction (OBS-17, stage-agnostic)', () => {
  it('resolves a retry to the server-derived handle + label (claims)', () => {
    expect(planSetAsideAction(CLAIMS, req({ action: 'retry', itemId: '01ADAID' }))).toEqual({
      handle: 'entities/people/01ADAID.md',
      label: 'Ada Lovelace',
    });
  });

  it('resolves a dismiss the same way', () => {
    expect(planSetAsideAction(CLAIMS, req({ action: 'dismiss', itemId: '01ADAID' }))).toEqual({
      handle: 'entities/people/01ADAID.md',
      label: 'Ada Lovelace',
    });
  });

  it('works identically for a connect target (blockKey handle) — stage-agnostic', () => {
    expect(planSetAsideAction(CONNECT, req({ stage: 'connect', action: 'retry', itemId: 'block:engine' }))).toEqual({
      handle: 'block:engine',
      label: 'Analytical Engine',
    });
  });

  it('rejects an unknown action', () => {
    const plan = planSetAsideAction(CLAIMS, req({ action: 'nuke' as PipelineControlRequest['action'] }));
    expect('error' in plan && plan.error).toContain('Unknown action');
  });

  it('reports a no-op when the item is no longer in the live list (already recovered/dismissed/stale)', () => {
    const plan = planSetAsideAction(CLAIMS, req({ itemId: '01GONE' }));
    expect('error' in plan && plan.error).toContain('no longer set aside');
  });

  it('reports a no-op against an empty list', () => {
    expect('error' in planSetAsideAction([], req({}))).toBe(true);
  });

  it('never trusts a renderer-supplied id absent from the server-built list (trust boundary)', () => {
    // A hostile/stale itemId that is not a real handle → no-op error, never returned as a handle.
    const plan = planSetAsideAction(CONNECT, req({ stage: 'connect', itemId: '../../etc/passwd' }));
    expect('error' in plan).toBe(true);
  });
});
