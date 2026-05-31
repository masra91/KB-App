// The Copilot-backed archivist (SPEC-0014 ORCH-8). Each item gets a fresh, disposable
// single-shot `copilot -p` session (ORCH-5) reusing the user's existing Copilot
// credentials — no auth in our flow. The session is THIN (ORCH-7): it returns a JSON
// decision and the orchestrator does all effects. Any failure (no CLI, timeout, bad
// output) falls back to the deterministic decision so archival never stalls.
//
// v1 is harness-focused: the decision stays conservative (confirm kind + defaults,
// CAPTURE-10) — the point is to PROVE the disposable-session + parse + fallback pattern
// that Enrich's richer agents will reuse. The subprocess is injectable so CI stays
// deterministic and never needs real credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CapturedMeta } from './ingest';
import { type ArchiveDecision, type ArchivistDecider, deterministicDecide } from './archivist';
import { detectCopilot } from './copilot';

const exec = promisify(execFile);
const COPILOT_TIMEOUT_MS = 60_000;

/** Injectable runner: given the composed prompt, return the session's stdout. */
export type CopilotRunner = (prompt: string) => Promise<string>;

const defaultRunner: CopilotRunner = async (prompt) => {
  const args = ['-p', prompt, '--no-ask-user'];
  const model = process.env.KB_COPILOT_MODEL;
  if (model) args.push('--model', model);
  const { stdout } = await exec('copilot', args, { timeout: COPILOT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

/** The versioned per-stage instruction template (SPEC-0014 Q9), composed per item. */
export function buildPrompt(meta: CapturedMeta): string {
  return [
    'You are the KB-App archivist. Classify ONE captured item for preservation.',
    'It is a primary source from the Principal. Use conservative defaults unless an',
    'explicit, high-confidence signal says otherwise. v1 supports only scope "global"',
    'and sensitivity "internal".',
    '',
    `kind: ${meta.kind}`,
    meta.originalName ? `originalName: ${meta.originalName}` : '',
    meta.mimeType ? `mimeType: ${meta.mimeType}` : '',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"kind":"text|file","class":"primary","scope":"global","sensitivity":"internal"}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Parse + validate the session output into a v1 ArchiveDecision (throws on anything off). */
export function parseDecision(stdout: string, meta: CapturedMeta): ArchiveDecision {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('copilot: no JSON object in output');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const kind = obj.kind === 'text' || obj.kind === 'file' ? obj.kind : meta.kind;
  if (obj.class !== 'primary' && obj.class !== 'secondary') throw new Error('copilot: invalid class');
  if (obj.scope !== 'global') throw new Error('copilot: invalid scope');
  if (obj.sensitivity !== 'internal') throw new Error('copilot: invalid sensitivity');
  return { kind, class: obj.class, scope: 'global', sensitivity: 'internal' };
}

export interface CopilotDeciderOptions {
  /** Force availability (skips detection). Tests set this; production detects lazily. */
  available?: boolean;
  /** Injected runner (tests). Defaults to shelling out to `copilot -p`. */
  run?: CopilotRunner;
}

/**
 * Build the production archivist decider: a fresh Copilot session per item, falling back
 * to the deterministic decision whenever Copilot is unavailable or misbehaves. Never
 * throws — always yields a decision so the orchestrator proceeds.
 */
export function makeCopilotDecider(opts: CopilotDeciderOptions = {}): ArchivistDecider {
  const run = opts.run ?? defaultRunner;
  let available: boolean | null = opts.available ?? null;
  return async (meta) => {
    if (available === null) {
      try {
        available = (await detectCopilot()).available;
      } catch {
        available = false;
      }
    }
    if (!available) return deterministicDecide(meta);
    try {
      return parseDecision(await run(buildPrompt(meta)), meta);
    } catch {
      return deterministicDecide(meta); // ORCH-8 resilience
    }
  };
}
