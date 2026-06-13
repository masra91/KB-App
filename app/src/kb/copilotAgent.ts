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
import { withCopilotSlot } from './copilotConcurrency';
import type { CapturedMeta } from './ingest';
import { type ArchiveDecision, type ArchivistDecider, deterministicDecide } from './archivist';
import { COPILOT_OP } from './tracing';
import { detectCopilot } from './copilot';
import { resolveCopilotModel } from './copilotModel';
import { runWithModelFallback } from './copilotLaunch';

const exec = promisify(execFile);
const COPILOT_TIMEOUT_MS = 60_000;

/** Injectable runner: given the composed prompt (+ optional working directory + model override),
 *  return the session's stdout. `cwd` scopes the Copilot subprocess to the staging worktree; `model`
 *  (when given) is the exact `--model` id to launch with — the model-fallback wrapper passes `auto`
 *  here on a retry. Omitting `model` falls back to the in-app pin. */
export type CopilotRunner = (prompt: string, cwd?: string, model?: string) => Promise<string>;

/** Launch flags (excludes `-p <prompt>`); recorded verbatim in the AgentTrace. The model is
 *  pinned in-app (ORCH-16) — see `copilotModel.ts`. Because we always pass `--model`, prod no
 *  longer silently inherits `~/.copilot/settings.json` and the recorded model is the real one
 *  that ran (never `default`); the eval harness still overrides it per variant. `model` lets the
 *  fallback wrapper launch with `auto` when the pinned id is rejected (recorded as the real model). */
function launchFlags(model: string = resolveCopilotModel()): string[] {
  return ['--no-ask-user', '--model', model];
}

const defaultRunner: CopilotRunner = async (prompt, cwd, model) =>
  // Acquire one global copilot slot so concurrent (cap>1) stage drains can't fan out past the
  // process-wide ceiling (dogfood #4 / copilotConcurrency).
  withCopilotSlot(async () => {
    try {
      // COPILOT-CONTEXT-SCOPE-BUG: run in the staging worktree (`cwd`) so Copilot's workspace
      // scan (`tgrep count-files`) is rooted here, NOT the filesystem root. With no cwd the
      // subprocess inherits Electron's cwd (`/` in a packaged app) → a runaway root scan.
      // `cwd: undefined` (tests / unscoped) behaves exactly as before (inherits parent cwd).
      const { stdout } = await exec('copilot', ['-p', prompt, ...launchFlags(model)], {
        timeout: COPILOT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        cwd,
      });
      return stdout;
    } catch (err) {
      // Surface the subprocess stderr on the error so the failure trace records the real cause (OBS-4).
      const stderr = (err as { stderr?: unknown }).stderr;
      if (err instanceof Error && stderr) err.message += `\n[copilot stderr] ${String(stderr).slice(0, 2000)}`;
      throw err;
    }
  }, { stage: 'archive' }); // SCALE-3: tag the stage so the ceiling reserves it a slot

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
  // v1 copilot stub asserts the conservative defaults; it does not classify sensitivity (that's SENSE
  // Slice 2's classifier → `by: classifier`). So this path lands at the default with `by: default`.
  return { kind, class: obj.class, scope: 'global', sensitivity: 'internal', sensitivityBy: 'default' };
}

export interface CopilotDeciderOptions {
  /** Force availability (skips detection). Tests set this; production detects lazily. */
  available?: boolean;
  /** Injected runner (tests). Defaults to shelling out to `copilot -p`. */
  run?: CopilotRunner;
  /** Working directory for the Copilot subprocess (the staging worktree, threaded from the
   *  pipeline). Set as the execFile `cwd` so Copilot's workspace scan stays scoped here, not the
   *  filesystem root — `--add-dir` only widens permissions, it does NOT move the cwd. */
  vaultPath?: string;
}

/**
 * Build the production archivist decider: a fresh Copilot session per item, falling back
 * to the deterministic decision whenever Copilot is unavailable or misbehaves. Never
 * throws — always yields a decision so the orchestrator proceeds.
 */
export function makeCopilotDecider(opts: CopilotDeciderOptions = {}): ArchivistDecider {
  const run = opts.run ?? defaultRunner;
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  let available: boolean | null = opts.available ?? null;
  return async (meta, ctx) => {
    if (available === null) {
      try {
        available = (await detectCopilot()).available;
      } catch {
        available = false;
      }
    }
    if (!available) {
      return { ...deterministicDecide(meta), agent: { via: 'deterministic', error: 'copilot unavailable' } };
    }

    // ORCH-16: record what we launched and what happened on every model invocation. `modelUsed`
    // starts at the pin and is rewritten to `auto` if the pinned id is rejected and we fall back —
    // so the trace records the model that ACTUALLY ran, making a silent pin-drift visible.
    let modelUsed = resolveCopilotModel();
    const at = new Date().toISOString();
    const t0 = Date.now();
    // OBS-13: time the Copilot call as a child of the stage's run span (failures included; the
    // archivist falls back rather than throwing, so the span ends `error` without re-throwing).
    const cs = ctx?.span?.child(COPILOT_OP);
    try {
      const decision = parseDecision(
        await runWithModelFallback((m) => run(buildPrompt(meta), cwd, m), { onFallback: (_from, to) => { modelUsed = to; } }),
        meta,
      );
      cs?.end('ok');
      return { ...decision, agent: { via: 'copilot', runtime: 'copilot', model: modelUsed, params: launchFlags(modelUsed), ok: true, ms: Date.now() - t0, at } };
    } catch (err) {
      // ORCH-8 resilience: fall back, but record the failure for posterity.
      cs?.end('error');
      const error = err instanceof Error ? err.message : String(err);
      return { ...deterministicDecide(meta), agent: { via: 'deterministic', runtime: 'copilot', model: modelUsed, params: launchFlags(modelUsed), ok: false, error, ms: Date.now() - t0, at } };
    }
  };
}
