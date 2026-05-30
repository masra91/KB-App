// Unit tests for Copilot availability detection (SPEC-0009 SETUP-4).
// Pure unit level (SPEC-0012 TEST-2): no real processes — `node:child_process`'s
// execFile is mocked at its promisified seam so we control what each candidate returns.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecResult = { stdout: string; stderr: string };
type ExecImpl = (cmd: string, args: string[]) => Promise<ExecResult>;

const rejectingImpl: ExecImpl = async () => {
  throw new Error('ENOENT');
};

// Hoisted so the (hoisted) vi.mock factory can reference it without TDZ issues.
const h = vi.hoisted(() => ({ impl: { current: undefined as unknown as ExecImpl } }));

// detectCopilot uses `promisify(execFile)`. promisify honors the well-known custom
// symbol, so we attach our impl there and promisify returns it directly.
vi.mock('node:child_process', () => {
  const PROMISIFY = Symbol.for('nodejs.util.promisify.custom');
  const execFile = function execFile() {
    throw new Error('callback form of execFile is not used in tests');
  };
  (execFile as unknown as Record<symbol, unknown>)[PROMISIFY] = (cmd: string, args: string[]) =>
    h.impl.current(cmd, args);
  return { execFile };
});

import { detectCopilot } from './copilot';

beforeEach(() => {
  h.impl.current = rejectingImpl;
});

describe('detectCopilot (SETUP-4)', () => {
  it('SETUP-4: reports unavailable when no Copilot CLI is on PATH', async () => {
    const status = await detectCopilot();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('No Copilot CLI found');
  });

  it('SETUP-4: reports available via the `copilot` CLI', async () => {
    h.impl.current = async (cmd) => {
      if (cmd === 'copilot') return { stdout: 'copilot version 1.2.3\n', stderr: '' };
      throw new Error('ENOENT');
    };
    const status = await detectCopilot();
    expect(status.available).toBe(true);
    expect(status.detail).toBe('copilot CLI: copilot version 1.2.3');
  });

  it('SETUP-4: falls back to the `gh copilot` extension', async () => {
    h.impl.current = async (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'copilot') return { stdout: 'version 0.5.0\n', stderr: '' };
      throw new Error('ENOENT');
    };
    const status = await detectCopilot();
    expect(status.available).toBe(true);
    expect(status.detail).toBe('gh copilot extension: version 0.5.0');
  });

  it('uses a fallback label when the CLI prints nothing', async () => {
    h.impl.current = async (cmd) => {
      if (cmd === 'copilot') return { stdout: '', stderr: '' };
      throw new Error('ENOENT');
    };
    const status = await detectCopilot();
    expect(status.available).toBe(true);
    expect(status.detail).toBe('copilot CLI: detected');
  });
});
