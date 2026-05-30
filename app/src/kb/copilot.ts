// Copilot availability detection (SETUP-4). Detection only — full GitHub Copilot SDK
// integration (the BYOA agent layer, AUTO-11) comes with the agent/enrich stories.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CopilotStatus } from './types';

const run = promisify(execFile);

// Candidate ways Copilot may be present on PATH. Exact SDK CLI is an open question
// (SPEC-0009 §5) — we probe the known shapes and report what we find.
const CANDIDATES: Array<{ cmd: string; args: string[]; label: string }> = [
  { cmd: 'copilot', args: ['--version'], label: 'copilot CLI' },
  { cmd: 'gh', args: ['copilot', '--version'], label: 'gh copilot extension' },
];

export async function detectCopilot(): Promise<CopilotStatus> {
  for (const c of CANDIDATES) {
    try {
      const { stdout } = await run(c.cmd, c.args, { timeout: 5000 });
      const first = stdout.trim().split('\n')[0] || 'detected';
      return { available: true, detail: `${c.label}: ${first}` };
    } catch {
      // try next candidate
    }
  }
  return {
    available: false,
    detail: 'No Copilot CLI found on PATH (looked for `copilot` and `gh copilot`).',
  };
}
