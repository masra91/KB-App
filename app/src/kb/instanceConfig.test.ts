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
} from './instanceConfig';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-instance-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('instance config store (PANEL-5)', () => {
  it('defaults to Guarded + info verbosity when no file exists', async () => {
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'guarded', devLogLevel: 'info' });
    expect(defaultInstanceConfig()).toEqual({ autonomyDefault: 'guarded', devLogLevel: 'info' });
  });

  it('round-trips a written config', async () => {
    await writeInstanceConfig(root, { autonomyDefault: 'autonomous', devLogLevel: 'debug' });
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'autonomous', devLogLevel: 'debug' });
    // Stored under .kb/instance.json (per-vault, never the app config).
    expect(instanceConfigPath(root).endsWith(path.join('.kb', 'instance.json'))).toBe(true);
  });

  it('falls back to the safe default on malformed JSON or an unknown posture', async () => {
    await fs.mkdir(path.join(root, '.kb'), { recursive: true });
    await fs.writeFile(instanceConfigPath(root), '{ not json', 'utf8');
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'guarded', devLogLevel: 'info' });
    await writeInstanceConfig(root, { autonomyDefault: 'reckless' as never, devLogLevel: 'info' });
    expect((await readInstanceConfig(root)).autonomyDefault).toBe('guarded');
  });

  it('OBS-10: devLogLevel round-trips and an unknown level falls back to info', async () => {
    await writeInstanceConfig(root, { autonomyDefault: 'guarded', devLogLevel: 'debug' });
    expect((await readInstanceConfig(root)).devLogLevel).toBe('debug');
    await writeInstanceConfig(root, { autonomyDefault: 'guarded', devLogLevel: 'screaming' as never });
    expect((await readInstanceConfig(root)).devLogLevel).toBe('info'); // unknown → safe default
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
