// SPEC-0027 PANEL-5 / AUTO-12 — per-Instance config store + the swappable posture resolver. Node tier.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readInstanceConfig,
  writeInstanceConfig,
  defaultInstanceConfig,
  instanceConfigPath,
  resolveJobPosture,
  clampRecallBudgetMs,
  DEFAULT_RECALL_BUDGET_MS,
  RECALL_BUDGET_MS_MIN,
  RECALL_BUDGET_MS_MAX,
} from './instanceConfig';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-instance-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const DEF = { autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS } as const;

describe('instance config store (PANEL-5)', () => {
  it('defaults to Guarded + info verbosity + ⌥Space hotkey when no file exists', async () => {
    expect(await readInstanceConfig(root)).toEqual(DEF);
    expect(defaultInstanceConfig()).toEqual(DEF);
  });

  it('round-trips a written config', async () => {
    await writeInstanceConfig(root, { autonomyDefault: 'autonomous', devLogLevel: 'debug', quickCaptureAccelerator: 'CommandOrControl+Shift+K', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS });
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'autonomous', devLogLevel: 'debug', quickCaptureAccelerator: 'CommandOrControl+Shift+K', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS });
    // Stored under .kb/instance.json (per-vault, never the app config).
    expect(instanceConfigPath(root).endsWith(path.join('.kb', 'instance.json'))).toBe(true);
  });

  it('falls back to the safe default on malformed JSON or an unknown posture', async () => {
    await fs.mkdir(path.join(root, '.kb'), { recursive: true });
    await fs.writeFile(instanceConfigPath(root), '{ not json', 'utf8');
    expect(await readInstanceConfig(root)).toEqual(DEF);
    await writeInstanceConfig(root, { autonomyDefault: 'reckless' as never, devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS });
    expect((await readInstanceConfig(root)).autonomyDefault).toBe('guarded');
  });

  it('OBS-10: devLogLevel round-trips and an unknown level falls back to info', async () => {
    await writeInstanceConfig(root, { autonomyDefault: 'guarded', devLogLevel: 'debug', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS });
    expect((await readInstanceConfig(root)).devLogLevel).toBe('debug');
    await writeInstanceConfig(root, { autonomyDefault: 'guarded', devLogLevel: 'screaming' as never, quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS });
    expect((await readInstanceConfig(root)).devLogLevel).toBe('info'); // unknown → safe default
  });

  it('QCAP-6: quickCaptureAccelerator round-trips; empty/non-string falls back to the ⌥Space default', async () => {
    await writeInstanceConfig(root, { autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Control+Alt+Q', recallBudgetMs: DEFAULT_RECALL_BUDGET_MS });
    expect((await readInstanceConfig(root)).quickCaptureAccelerator).toBe('Control+Alt+Q');
    // An empty/garbage stored value is replaced by the default (full grammar validation is at register).
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: '' }), 'utf8');
    expect((await readInstanceConfig(root)).quickCaptureAccelerator).toBe('Alt+Space');
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 42 }), 'utf8');
    expect((await readInstanceConfig(root)).quickCaptureAccelerator).toBe('Alt+Space');
  });

  it('SPEC-0048: the model override + preferences round-trip; empty/garbage/legacy → omitted (no override)', async () => {
    // A configured global model + preference list persist.
    await writeInstanceConfig(root, { ...DEF, model: 'claude-opus-4.8', modelPreferences: ['claude-opus-4.8', 'claude-sonnet-4.5'] });
    const got = await readInstanceConfig(root);
    expect(got.model).toBe('claude-opus-4.8');
    expect(got.modelPreferences).toEqual(['claude-opus-4.8', 'claude-sonnet-4.5']);
    // A legacy file (no model field) → undefined (no override; the preference-list probe drives).
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ ...DEF }), 'utf8');
    expect((await readInstanceConfig(root)).model).toBeUndefined();
    // Empty/non-string model or an all-junk preference array → omitted, not a broken value.
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ ...DEF, model: '  ', modelPreferences: [42, ''] }), 'utf8');
    const cleaned = await readInstanceConfig(root);
    expect(cleaned.model).toBeUndefined();
    expect(cleaned.modelPreferences).toBeUndefined();
  });

  it('ASK-17: recallBudgetMs round-trips, clamps out-of-range, and a legacy file (no field) → default', async () => {
    await writeInstanceConfig(root, { ...DEF, recallBudgetMs: 300_000 });
    expect((await readInstanceConfig(root)).recallBudgetMs).toBe(300_000); // an in-range value round-trips

    // Out-of-range values clamp to the sane bounds (never below the old 60s, never an unbounded hang).
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ ...DEF, recallBudgetMs: 5_000 }), 'utf8');
    expect((await readInstanceConfig(root)).recallBudgetMs).toBe(RECALL_BUDGET_MS_MIN);
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ ...DEF, recallBudgetMs: 9_999_999 }), 'utf8');
    expect((await readInstanceConfig(root)).recallBudgetMs).toBe(RECALL_BUDGET_MS_MAX);

    // A legacy/garbled value (or a config written before ASK-17) reads back as the raised default.
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' }), 'utf8');
    expect((await readInstanceConfig(root)).recallBudgetMs).toBe(DEFAULT_RECALL_BUDGET_MS);
    await fs.writeFile(instanceConfigPath(root), JSON.stringify({ ...DEF, recallBudgetMs: 'soon' }), 'utf8');
    expect((await readInstanceConfig(root)).recallBudgetMs).toBe(DEFAULT_RECALL_BUDGET_MS);
  });

  it('ASK-17: clampRecallBudgetMs bounds the value (default ≥ 60s, ≤ 10min)', () => {
    expect(clampRecallBudgetMs(240_000)).toBe(240_000);
    expect(clampRecallBudgetMs(1)).toBe(RECALL_BUDGET_MS_MIN);
    expect(clampRecallBudgetMs(99_999_999)).toBe(RECALL_BUDGET_MS_MAX);
    expect(clampRecallBudgetMs('nope')).toBe(DEFAULT_RECALL_BUDGET_MS);
    expect(DEFAULT_RECALL_BUDGET_MS).toBeGreaterThan(60_000); // the old hard 60s was too tight
  });
});

describe('resolveJobPosture — AUTO-12 cascade (the swap point)', () => {
  it('an explicit per-job posture wins over the Instance default', () => {
    expect(resolveJobPosture('guarded', 'autonomous')).toBe('autonomous');
    expect(resolveJobPosture('autonomous', 'guarded')).toBe('guarded');
  });
  it('a job with no explicit posture inherits the Instance default', () => {
    expect(resolveJobPosture('autonomous', undefined)).toBe('autonomous');
    expect(resolveJobPosture('guarded', undefined)).toBe('guarded');
  });
});
