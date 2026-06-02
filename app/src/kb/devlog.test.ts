// SPEC-0030 OBS-1/2/3 — the diagnostic dev-log subsystem (leveled, size-rotated JSONL,
// redaction-aware, runId/itemId cross-link). Standalone unit; the pipeline wiring (OBS-4) follows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createDevLog, noopDevLog, vaultLogDir, createVaultDevLog, createAppDevLog, readRecentDevLogEntries } from './devlog';

const NOW = (): string => '2026-06-02T00:00:00.000Z';

async function readLines(dir: string, file = 'pipeline.log'): Promise<Record<string, unknown>[]> {
  const txt = await fs.readFile(path.join(dir, file), 'utf8');
  return txt
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('devlog (SPEC-0030 OBS-1/2/3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('kb-devlog-');
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('writes leveled JSONL entries and filters below the configured level (OBS-1)', async () => {
    const log = createDevLog({ dir, level: 'info', now: NOW });
    log.debug('skipped', { a: 1 });
    log.info('hi', { a: 1 });
    log.warn('warn', {});
    log.error('boom', {});
    await log.flush();
    const lines = await readLines(dir);
    expect(lines.map((l) => l.event)).toEqual(['hi', 'warn', 'boom']); // debug filtered out
    expect(lines[0]).toMatchObject({ ts: NOW(), level: 'info', event: 'hi', a: 1 });
  });

  it('binds scope + runId/itemId via child for the audit cross-link (OBS-3)', async () => {
    const log = createDevLog({ dir, now: NOW }).child({ scope: 'decompose', runId: 'R1' });
    log.error('decompose.failed', { itemId: 'S1', attempt: 3 });
    await log.flush();
    const [e] = await readLines(dir);
    expect(e).toMatchObject({ scope: 'decompose', runId: 'R1', event: 'decompose.failed', itemId: 'S1', attempt: 3 });
  });

  it('normalizes an Error into {message, stack} (OBS-4 cause capture)', async () => {
    const log = createDevLog({ dir, now: NOW });
    log.error('x', { err: new Error('kaboom') });
    await log.flush();
    const [e] = await readLines(dir);
    const err = e.err as { message: string; stack: string };
    expect(err.message).toBe('kaboom');
    expect(typeof err.stack).toBe('string');
  });

  it('redacts sensitive fields at info, includes them verbatim at debug (OBS-10 minimal)', async () => {
    const info = createDevLog({ dir, level: 'info', now: NOW });
    info.info('capture', { sensitive: { text: 'secret source text' } });
    await info.flush();
    expect((await readLines(dir))[0].sensitive).toEqual({ text: '[redacted]' });

    const dbgDir = await makeTempDir('kb-devlog-dbg-');
    const dbg = createDevLog({ dir: dbgDir, level: 'debug', now: NOW });
    dbg.debug('capture', { sensitive: { text: 'secret source text' } });
    await dbg.flush();
    expect((await readLines(dbgDir))[0].sensitive).toEqual({ text: 'secret source text' });
    await rmTempDir(dbgDir);
  });

  it('rotates by size, keeping maxFiles and dropping the oldest (OBS-2)', async () => {
    const log = createDevLog({ dir, level: 'info', maxBytes: 200, maxFiles: 2, now: NOW });
    for (let i = 0; i < 20; i++) log.info('e', { i, pad: 'x'.repeat(50) });
    await log.flush();
    expect(await pathExists(path.join(dir, 'pipeline.log'))).toBe(true);
    expect(await pathExists(path.join(dir, 'pipeline.log.1'))).toBe(true);
    expect(await pathExists(path.join(dir, 'pipeline.log.2'))).toBe(true);
    expect(await pathExists(path.join(dir, 'pipeline.log.3'))).toBe(false); // dropped beyond maxFiles
  });

  it('noopDevLog writes nothing and creates no file', async () => {
    noopDevLog.error('x', { err: new Error('y') });
    noopDevLog.child({ scope: 's' }).info('z');
    await noopDevLog.flush();
    expect(await pathExists(path.join(dir, 'pipeline.log'))).toBe(false);
  });

  it('never throws into the caller, even when the target dir is unwritable', async () => {
    const filePath = path.join(dir, 'not-a-dir');
    await fs.writeFile(filePath, 'x');
    const log = createDevLog({ dir: path.join(filePath, 'sub'), now: NOW }); // mkdir will fail (ENOTDIR)
    expect(() => log.error('boom', {})).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe('sink locations (SPEC-0030 OBS-2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('kb-obs2-');
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('vaultLogDir is <vault>/.kb/cache/logs (gitignored under .kb/cache, never promoted)', () => {
    expect(vaultLogDir('/some/vault')).toBe(path.join('/some/vault', '.kb', 'cache', 'logs'));
  });

  it('createVaultDevLog writes to <vault>/.kb/cache/logs/pipeline.log', async () => {
    const log = createVaultDevLog(dir, { now: NOW });
    log.error('x', { itemId: 'S1' });
    await log.flush();
    const p = path.join(dir, '.kb', 'cache', 'logs', 'pipeline.log');
    expect(await pathExists(p)).toBe(true);
    expect((await readLines(path.join(dir, '.kb', 'cache', 'logs')))[0]).toMatchObject({ event: 'x', itemId: 'S1' });
  });

  it('createAppDevLog writes to <userData>/logs/app.log (pre-vault/boot errors)', async () => {
    const log = createAppDevLog(dir, { now: NOW });
    log.error('boot.init-pipeline-failed', {});
    await log.flush();
    expect(await pathExists(path.join(dir, 'logs', 'app.log'))).toBe(true);
    expect((await readLines(path.join(dir, 'logs'), 'app.log'))[0]).toMatchObject({ event: 'boot.init-pipeline-failed', level: 'error' });
  });
});

describe('readRecentDevLogEntries (SPEC-0030 OBS-6 — recent errors for the Status view)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await makeTempDir('kb-devlog-read-');
  });
  afterEach(async () => {
    await rmTempDir(vault);
  });

  it('returns warn+error entries newest-first, filtering out info/debug, capped to limit', async () => {
    const log = createVaultDevLog(vault, { level: 'debug', now: NOW }).child({ scope: 'decompose' });
    log.debug('noise');
    log.info('start', { itemId: 'SRC1' });
    log.warn('decompose.setaside', { itemId: 'SRC2', reason: 'collision-exhausted' });
    log.error('decompose.failed', { runId: 'R1', itemId: 'SRC3', err: new Error('copilot exploded') });
    await log.flush();

    const recent = await readRecentDevLogEntries(vault);
    expect(recent).toHaveLength(2); // only warn + error (info/debug filtered)
    expect(recent[0]).toMatchObject({ event: 'decompose.failed', level: 'error', itemId: 'SRC3', runId: 'R1' }); // newest-first
    expect(recent[0].err?.message).toBe('copilot exploded'); // cause carried (OBS-3 cross-link)
    expect(recent[0].scope).toBe('decompose');
    expect(recent[1]).toMatchObject({ event: 'decompose.setaside', level: 'warn', itemId: 'SRC2' });
  });

  it('honors minLevel and limit', async () => {
    const log = createVaultDevLog(vault, { level: 'debug', now: NOW });
    log.warn('w1');
    log.error('e1');
    log.error('e2');
    await log.flush();

    expect(await readRecentDevLogEntries(vault, { minLevel: 'error' })).toHaveLength(2); // warns excluded
    expect(await readRecentDevLogEntries(vault, { limit: 1 })).toHaveLength(1); // newest only
    expect((await readRecentDevLogEntries(vault, { limit: 1 }))[0].event).toBe('e2');
  });

  it('a missing log yields an empty list (never throws)', async () => {
    await expect(readRecentDevLogEntries(vault)).resolves.toEqual([]);
  });
});
