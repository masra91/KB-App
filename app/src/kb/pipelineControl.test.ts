// SPEC-0030 OBS-17 — the pure recovery-action planner behind `kb:pipelineControl`.
import { describe, it, expect } from 'vitest';
import { planSetAsideAction } from './pipelineControl';
import type { SetAsideItem } from './claimsStage';
import type { PipelineControlRequest } from './types';

const ITEMS: SetAsideItem[] = [
  { entityRel: 'entities/people/01ADAID.md', entityId: '01ADAID', kind: 'person', name: 'Ada Lovelace', derivedFrom: 'sources/s1', failures: 3, rounds: 0 },
  { entityRel: 'entities/people/01NONAME.md', entityId: '01NONAME', kind: 'person', name: '', derivedFrom: 'sources/s2', failures: 0, rounds: 2 },
];
const req = (over: Partial<PipelineControlRequest>): PipelineControlRequest => ({ action: 'retry', stage: 'claims', itemId: '01ADAID', ...over });

describe('planSetAsideAction (OBS-17)', () => {
  it('resolves a retry to the entity node path + friendly label', () => {
    expect(planSetAsideAction(ITEMS, req({ action: 'retry', itemId: '01ADAID' }))).toEqual({
      entityRel: 'entities/people/01ADAID.md',
      label: 'Ada Lovelace',
    });
  });

  it('resolves a dismiss the same way (handle = entityRel)', () => {
    expect(planSetAsideAction(ITEMS, req({ action: 'dismiss', itemId: '01ADAID' }))).toEqual({
      entityRel: 'entities/people/01ADAID.md',
      label: 'Ada Lovelace',
    });
  });

  it('falls back to the id as the label when the entity has no name', () => {
    const plan = planSetAsideAction(ITEMS, req({ itemId: '01NONAME' }));
    expect(plan).toEqual({ entityRel: 'entities/people/01NONAME.md', label: '01NONAME' });
  });

  it('rejects a non-claims stage (claims-only v1) without resolving', () => {
    const plan = planSetAsideAction(ITEMS, req({ stage: 'decompose' }));
    expect(plan).toHaveProperty('error');
    expect('error' in plan && plan.error).toContain('decompose');
  });

  it('rejects an unknown action', () => {
    const plan = planSetAsideAction(ITEMS, req({ action: 'nuke' as PipelineControlRequest['action'] }));
    expect('error' in plan && plan.error).toContain('Unknown action');
  });

  it('reports a no-op when the item is no longer set aside (already recovered/dismissed)', () => {
    const plan = planSetAsideAction(ITEMS, req({ itemId: '01GONE' }));
    expect('error' in plan && plan.error).toContain('no longer set aside');
  });

  it('reports a no-op against an empty list', () => {
    expect('error' in planSetAsideAction([], req({}))).toBe(true);
  });
});
