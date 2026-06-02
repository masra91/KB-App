// SPEC-0027 PANEL-2/7 — pure Jobs view-model logic. Node tier (no DOM), per SHELL-6 / TEST-5.
import { describe, it, expect } from 'vitest';
import { buildJobViews, isRiskyJobChange, schedulePresetLabel, isSchedulePreset, SCHEDULE_OPTIONS } from './jobsPanel';
import type { JobCatalogEntry } from './jobCatalog';
import type { JobConfig, JournalEntry } from './jobs';
import type { JobView, JobConfigPatch } from './types';

const CATALOG: JobCatalogEntry[] = [
  { type: 'example', label: 'Entity census', description: 'reference', production: false },
  { type: 'reflect', label: 'Reflect', description: 'rumination', production: true },
];

function cfg(over: Partial<JobConfig> & Pick<JobConfig, 'id' | 'type'>): JobConfig {
  return { schedule: 'off', enabled: false, posture: 'guarded', ...over };
}

describe('buildJobViews — catalog ∪ registry (PANEL-2)', () => {
  it('yields one row per catalog type even when the registry is empty (catalog-only defaults)', () => {
    const views = buildJobViews(CATALOG, [], {});
    expect(views.map((v) => v.id)).toEqual(['example', 'reflect']);
    for (const v of views) {
      expect(v.registered).toBe(false);
      expect(v.enabled).toBe(false);
      expect(v.schedule).toBe('off');
      expect(v.posture).toBe('guarded');
      expect(v.lastRun).toBeNull();
    }
    // Catalog metadata flows through (incl. the non-production flag on the example job).
    expect(views[0]).toMatchObject({ label: 'Entity census', production: false });
    expect(views[1]).toMatchObject({ label: 'Reflect', production: true });
  });

  it('overlays a registered job’s persisted config and marks it registered', () => {
    const registry = [cfg({ id: 'reflect', type: 'reflect', enabled: true, schedule: 'hourly', posture: 'autonomous' })];
    const views = buildJobViews(CATALOG, registry, {});
    const reflect = views.find((v) => v.id === 'reflect')!;
    expect(reflect).toMatchObject({ registered: true, enabled: true, schedule: 'hourly', posture: 'autonomous' });
    // The unregistered catalog job still shows its defaults.
    expect(views.find((v) => v.id === 'example')!.registered).toBe(false);
  });

  it('lists a registered job that has no catalog entry (never hide a runnable job), after catalog rows', () => {
    const registry = [cfg({ id: 'legacy', type: 'legacy', enabled: true, schedule: 'daily' })];
    const views = buildJobViews(CATALOG, registry, {});
    expect(views.map((v) => v.id)).toEqual(['example', 'reflect', 'legacy']);
    const legacy = views.find((v) => v.id === 'legacy')!;
    expect(legacy).toMatchObject({ label: 'legacy', registered: true, enabled: true, production: false });
  });

  it('attaches the newest journal entry as lastRun, including a set-aside note', () => {
    const entry: JournalEntry = {
      ts: '2026-06-02T07:00:00.000Z',
      runId: 'r1',
      inspected: 'entities/ (3 nodes)',
      applied: 1,
      deferred: 2,
    };
    const setAside: JournalEntry = { ts: '2026-06-02T08:00:00.000Z', runId: 'r2', inspected: 'entities/', applied: 0, deferred: 0, note: 'collision-exhausted' };
    const views = buildJobViews(CATALOG, [], { example: entry, reflect: setAside });
    expect(views.find((v) => v.id === 'example')!.lastRun).toEqual({
      ts: '2026-06-02T07:00:00.000Z',
      inspected: 'entities/ (3 nodes)',
      applied: 1,
      deferred: 2,
    });
    expect(views.find((v) => v.id === 'reflect')!.lastRun).toEqual({
      ts: '2026-06-02T08:00:00.000Z',
      inspected: 'entities/',
      applied: 0,
      deferred: 0,
      note: 'collision-exhausted',
    });
  });
});

describe('isRiskyJobChange — confirm + audit gate (PANEL-7)', () => {
  const base: Pick<JobView, 'enabled' | 'posture'> = { enabled: false, posture: 'guarded' };
  const patch = (over: Partial<JobConfigPatch>): JobConfigPatch => ({ id: 'x', type: 'x', ...over });

  it('enabling a disabled job is risky', () => {
    expect(isRiskyJobChange(base, patch({ enabled: true }))).toBe(true);
  });
  it('moving to Autonomous is risky', () => {
    expect(isRiskyJobChange(base, patch({ posture: 'autonomous' }))).toBe(true);
  });
  it('disabling, changing cadence, or relaxing to Guarded is not risky', () => {
    expect(isRiskyJobChange({ enabled: true, posture: 'autonomous' }, patch({ enabled: false }))).toBe(false);
    expect(isRiskyJobChange(base, patch({ schedule: 'daily' }))).toBe(false);
    expect(isRiskyJobChange({ enabled: true, posture: 'autonomous' }, patch({ posture: 'guarded' }))).toBe(false);
  });
  it('a patch that re-asserts the current value is not risky', () => {
    expect(isRiskyJobChange({ enabled: true, posture: 'guarded' }, patch({ enabled: true }))).toBe(false);
    expect(isRiskyJobChange({ enabled: false, posture: 'autonomous' }, patch({ posture: 'autonomous' }))).toBe(false);
  });
});

describe('schedule preset helpers', () => {
  it('labels every preset and offers them with off last', () => {
    expect(schedulePresetLabel('several-daily')).toBe('A few times a day');
    expect(schedulePresetLabel('off')).toBe('Off');
    expect(SCHEDULE_OPTIONS[SCHEDULE_OPTIONS.length - 1]).toBe('off');
  });
  it('validates schedule strings from untrusted IPC input', () => {
    expect(isSchedulePreset('hourly')).toBe(true);
    expect(isSchedulePreset('weekly')).toBe(false);
    expect(isSchedulePreset(42)).toBe(false);
  });
});
