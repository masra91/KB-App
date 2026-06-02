// Git-less coverage of the REPLAY-6 epoch filter inside the real stage queue-readers. Builds a
// source dir by hand (fs only) and asserts the decompose reader re-queues it after a replay-reset
// despite a prior terminal `decomposed` marker — the core "re-derive from scratch" behavior.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { readDecomposeQueue } from './decomposeStage';
import { replayResetLine } from './replayEpoch';

const j = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

async function writeSource(root: string, id: string, auditLines: string): Promise<void> {
  const dir = path.join(root, 'sources', '2026', '06', '02', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'source.md'), `---\nid: ${id}\n---\nbody\n`);
  await fs.writeFile(path.join(dir, 'audit.jsonl'), auditLines);
}

describe('replay epoch filter in the decompose reader (REPLAY-6, git-less)', () => {
  it('a decomposed source is dequeued — until a replay-reset re-queues it', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      // Source A: decomposed, no replay → stays OUT of the queue.
      await writeSource(root, 'AAAAAAAAAAAAAAAAAAAAAAAAAA', j({ stage: 'decompose', event: 'decomposed', entities: 1 }));
      expect(await readDecomposeQueue(root)).toEqual([]);

      // Source A after a replay-reset → re-enters the queue (old terminal marker ignored).
      await writeSource(
        root,
        'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        j({ stage: 'decompose', event: 'decomposed', entities: 1 }) + replayResetLine('R1', '2026-06-02T00:00:00.000Z'),
      );
      const queued = await readDecomposeQueue(root);
      expect(queued.length).toBe(1);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a post-epoch terminal marker dequeues again (re-derive completes under the new epoch)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await writeSource(
        root,
        'BBBBBBBBBBBBBBBBBBBBBBBBBB',
        j({ stage: 'decompose', event: 'decomposed' }) +
          replayResetLine('R1', '2026-06-02T00:00:00.000Z') +
          j({ stage: 'decompose', event: 'decomposed', entities: 2 }), // re-derived under R1
      );
      expect(await readDecomposeQueue(root)).toEqual([]); // terminal again, post-epoch
    } finally {
      await rmTempDir(dir);
    }
  });

  it('failure counts also reset across the epoch (a previously-exhausted source retries)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const threeFails =
        j({ stage: 'decompose', event: 'failed' }) +
        j({ stage: 'decompose', event: 'failed' }) +
        j({ stage: 'decompose', event: 'failed' });
      // 3 failures (>= maxAttempts) → dequeued…
      await writeSource(root, 'CCCCCCCCCCCCCCCCCCCCCCCCCC', threeFails);
      expect(await readDecomposeQueue(root, 3)).toEqual([]);
      // …until a replay-reset clears the count.
      await writeSource(root, 'CCCCCCCCCCCCCCCCCCCCCCCCCC', threeFails + replayResetLine('R1', '2026-06-02T00:00:00.000Z'));
      expect((await readDecomposeQueue(root, 3)).length).toBe(1);
    } finally {
      await rmTempDir(dir);
    }
  });
});
