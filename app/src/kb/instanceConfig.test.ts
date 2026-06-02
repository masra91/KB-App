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
  it('defaults to Guarded when no file exists', async () => {
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'guarded' });
    expect(defaultInstanceConfig()).toEqual({ autonomyDefault: 'guarded' });
  });

  it('round-trips a written config', async () => {
    await writeInstanceConfig(root, { autonomyDefault: 'autonomous' });
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'autonomous' });
    // Stored under .kb/instance.json (per-vault, never the app config).
    expect(instanceConfigPath(root).endsWith(path.join('.kb', 'instance.json'))).toBe(true);
  });

  it('falls back to the safe default on malformed JSON or an unknown posture', async () => {
    await fs.mkdir(path.join(root, '.kb'), { recursive: true });
    await fs.writeFile(instanceConfigPath(root), '{ not json', 'utf8');
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'guarded' });
    await writeInstanceConfig(root, { autonomyDefault: 'reckless' as never });
    expect(await readInstanceConfig(root)).toEqual({ autonomyDefault: 'guarded' });
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
