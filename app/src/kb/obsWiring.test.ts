// SPEC-0030 OBS-3/4 — errors-never-silent wiring. A stage failure must emit BOTH the structured
// audit event (existing) AND a dev-log entry carrying the SAME runId (the OBS-3 cross-link) with
// the verbose cause (incl. any subprocess stderr the runner appended). Real FS+git temp vault; the
// decider is injected to throw (no copilot), and a real DevLog is injected into the stage.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { DecomposeStage } from './decomposeStage';
import { createDevLog } from './devlog';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface AuditLine {
  event?: string;
  runId?: string;
  sourceId?: string;
}
interface DevLine {
  event?: string;
  scope?: string;
  runId?: string;
  itemId?: string;
  setAside?: boolean;
  err?: { message?: string };
}

describe('OBS-3/4 — errors-never-silent wiring', () => {
  it('a Decompose failure writes the audit event AND a cross-linked dev-log entry (matching runId + cause)', async () => {
    if (!gitAvailable()) return; // git-less unit runner: skip (CI has git)
    const dir = await makeTempDir('kb-obs-');
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, name: 'OBS', initGitIfNeeded: true });
      await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'Ada Lovelace worked with Charles Babbage.' }]);
      const q = await readQueue(root);
      const sourceRel = await archiveOne(root, q[q.length - 1], deterministicDecider);

      const logDir = path.join(dir, 'logs');
      const log = createDevLog({ dir: logDir });
      // Decider throws with an enriched message (as the agent runner does after appending stderr).
      const throwing = async (): Promise<never> => {
        throw new Error('decider failed\n[copilot stderr] boom');
      };
      // maxAttempts=1 ⇒ fail + set aside in one pass; cap=1; inject the real DevLog.
      const stage = new DecomposeStage(root, throwing, new Mutex(), 1, 1, log);
      await stage.poke();
      await log.flush();

      // Structured audit (existing behavior): a 'failed' event in the source's audit.jsonl.
      const auditTxt = await fs.readFile(path.join(root, sourceRel, 'audit.jsonl'), 'utf8');
      const failed = auditTxt
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AuditLine)
        .find((e) => e.event === 'failed');
      expect(failed).toBeTruthy();

      // Dev-log (OBS-4): a decompose.failed entry, scoped, with the SAME runId (OBS-3) + the cause.
      const devTxt = await fs.readFile(path.join(logDir, 'pipeline.log'), 'utf8');
      const devFailed = devTxt
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as DevLine)
        .find((e) => e.event === 'decompose.failed');
      expect(devFailed).toBeTruthy();
      expect(devFailed!.scope).toBe('decompose');
      expect(devFailed!.runId).toBe(failed!.runId); // the cross-link
      expect(devFailed!.itemId).toBe(failed!.sourceId);
      expect(devFailed!.setAside).toBe(true);
      expect(devFailed!.err?.message).toContain('[copilot stderr] boom'); // verbose cause incl. stderr
    } finally {
      await rmTempDir(dir);
    }
  });
});
