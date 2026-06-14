// The thin Compose agent (SPEC-0046 COMPOSE-7, reusing the SPEC-0014/0016 harness pattern). Each
// entity gets a fresh, disposable single-shot `copilot -p` session (ORCH-5/21) with NO tools: it
// returns a JSON decision (grounded prose) and the orchestrator does every effect. Mirrors
// claimsAgent.ts so the harness is reused, not reinvented (ORCH-9).
//
// Grounding is the non-negotiable (SPEC-0046 §3): the agent may synthesize ONLY from the numbered
// claims it is given, and every sentence it returns must cite the claim(s) it draws on. The parse
// seam (parseComposeDecision) REJECTS an un-grounded answer, so a bad session can't write
// ungrounded prose — the stage retries and then falls back to the structured blocks alone (never a
// hard failure; unlike Research, Compose performs NO egress).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCopilotSlot } from './copilotConcurrency';
import { detectCopilot } from './copilot';
import { resolveCopilotModel } from './copilotModel';
import { runWithModelFallback } from './copilotLaunch';
import { runWithSelfRepair, appendRepairInstruction } from './selfRepair';
import { parseComposeDecision, type ComposeDecision } from './compose';
import type { AgentTrace } from './archivist';
import { COPILOT_OP, type SpanCtx } from './tracing';

const exec = promisify(execFile);
const COPILOT_TIMEOUT_MS = 120_000; // composing readable prose over many claims takes time

/** One claim offered to Compose as evidence — numbered 1..N (array order); the agent cites by number. */
export interface ComposeClaimInput {
  statement: string;
  /** The source's human title — context only; the citation the agent emits is the claim NUMBER. */
  title: string;
}

/** The work item as the Compose agent sees it: ONE entity + its cited claims + the names of the
 *  entities it links to (so cross-links can be woven into the prose; COMPOSE-4). */
export interface ComposeInput {
  entityId: string;
  kind: string;
  name: string;
  claims: ComposeClaimInput[];
  links: string[];
}

/** A decider maps a ComposeInput to a validated, grounded ComposeDecision. May throw (COMPOSE-7). */
export type ComposeDecider = (input: ComposeInput, ctx?: SpanCtx) => Promise<ComposeDecision>;

/** Injectable runner: given the composed prompt (+ optional working directory), return the
 *  session's stdout. `cwd` scopes the Copilot subprocess to the staging worktree. */
export type CopilotRunner = (prompt: string, cwd?: string, model?: string) => Promise<string>;

/** Launch flags (excludes `-p <prompt>`); recorded verbatim in the AgentTrace (ORCH-16). The
 *  model is pinned in-app so prod never silently inherits `~/.copilot/settings.json`. `model` lets
 *  the fallback wrapper launch with `auto` when the pinned id is rejected (recorded as the real model). */
function launchFlags(model: string = resolveCopilotModel()): string[] {
  return ['--no-ask-user', '--model', model];
}

const defaultRunner: CopilotRunner = async (prompt, cwd, model) =>
  // One global copilot slot so concurrent stage drains can't fan out past the process-wide ceiling.
  withCopilotSlot(async () => {
    try {
      // COPILOT-CONTEXT-SCOPE-BUG: run in the staging worktree (`cwd`) so Copilot's workspace
      // scan (`tgrep count-files`) is rooted here, NOT the filesystem root. With no cwd the
      // subprocess inherits Electron's cwd (`/` in a packaged app) → a runaway root scan.
      // `cwd: undefined` (tests / unscoped) behaves exactly as before (inherits parent cwd).
      const { stdout } = await exec('copilot', ['-p', prompt, ...launchFlags(model)], {
        timeout: COPILOT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        cwd,
      });
      return stdout;
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr;
      if (err instanceof Error && stderr) err.message += `\n[copilot stderr] ${String(stderr).slice(0, 2000)}`;
      throw err;
    }
  }, { stage: 'compose' }); // SCALE-3: tag the stage so the ceiling reserves it a slot

/** The versioned per-stage instruction template (SPEC-0046 §3/§4), composed per entity. */
export const COMPOSE_PROMPT_VERSION = 'compose/v1';

export function buildComposePrompt(input: ComposeInput): string {
  const claimLines = input.claims.map((c, i) => `  [${i + 1}] ${c.statement}  (source: ${c.title})`);
  const linkLine =
    input.links.length > 0
      ? `These related entities have their own pages — when you mention one, write its name as a [[wikilink]]: ${input.links
          .map((n) => `[[${n}]]`)
          .join(', ')}.`
      : 'There are no related entities to link.';
  return [
    'You are the KB-App Compose editor. Write an ENCYCLOPEDIC page about ONE entity — like a',
    'Wikipedia article: a lede that says what/who it is, then sections that group related facts',
    'into flowing prose. NOT a bullet list, NOT a metadata dump.',
    '',
    'SCALE THE DEPTH TO THE EVIDENCE (COMPOSE-10). When there are MANY claims, write a fuller,',
    'multi-section article — a lede plus several thematic `##` sections that develop the entity in',
    'depth. When there are FEW claims, write a short but clean page — a tight lede, perhaps one',
    'section. The length must match how much grounded material exists: a richly-documented entity',
    'reads like a real encyclopedia entry, a thin one stays brief. NEVER pad, repeat, or speculate to',
    'fill space — more depth means MORE of the grounded claims woven in, never invented detail.',
    '',
    'GROUNDING IS ABSOLUTE. You may use ONLY the numbered claims below. You may NOT introduce a',
    'fact that is not in a claim, and you may NOT use outside knowledge. EVERY sentence you write',
    'must be grounded in one or more of the numbered claims, and you must list those claim numbers',
    'for that sentence. A sentence with no claim is forbidden (it would be an un-grounded statement).',
    'Do not write the citation markers yourself — just list the claim numbers per sentence; the',
    'system renders the citations and the References section.',
    '',
    linkLine,
    '',
    `entity.kind: ${input.kind}`,
    `entity.name: ${input.name}`,
    'CLAIMS (the ONLY material you may use; cite by number):',
    ...claimLines,
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"sections":[{"heading":"<omit on the first/lede section>","sentences":[{"text":"<one prose sentence, may contain [[Entity]] links, NO citation markers>","claims":[1,2]}]}]}',
    'The first section is the lede and should omit "heading". Add further `##` sections only as the',
    'claims warrant — match the article length to the grounded material (COMPOSE-10).',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ComposeDeciderOptions {
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
 * Build the production Compose decider: a fresh Copilot session per entity. THROWS when Copilot is
 * unavailable OR the output is bad OR the prose is un-grounded (parseComposeDecision enforces the
 * grounding invariants) — the stage retries and, after K attempts, falls back to blocks-only.
 * Stamps an ORCH-16 AgentTrace onto the returned decision.
 */
export function makeComposeDecider(opts: ComposeDeciderOptions = {}): ComposeDecider {
  const run = opts.run ?? defaultRunner;
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  let available: boolean | null = opts.available ?? null;
  return async (input, ctx) => {
    if (available === null) {
      try {
        available = (await detectCopilot()).available;
      } catch {
        available = false;
      }
    }
    if (!available) throw new Error('compose: copilot unavailable');

    // ORCH-16: `modelUsed` starts at the pin and is rewritten to `auto` if the pinned id is rejected
    // and we fall back — so the trace records the model that ACTUALLY ran (a silent pin-drift is visible).
    let modelUsed = resolveCopilotModel();
    const at = new Date().toISOString();
    const t0 = Date.now();
    const cs = ctx?.span?.child(COPILOT_OP);
    // HEAL-1: self-repair wraps the launch — on a parse/validation/grounding failure, re-prompt with the
    // error fed back (bounded) before the stage's deterministic blocks-only fallback. A launch/timeout
    // error from `run` is not a parse error and propagates (HEAL-6 boundary).
    const basePrompt = buildComposePrompt(input);
    let repairs = 0;
    try {
      const { value: decision } = await runWithSelfRepair(
        (repair) =>
          runWithModelFallback((m) => run(repair ? appendRepairInstruction(basePrompt, repair) : basePrompt, cwd, m), {
            onFallback: (_from, to) => {
              modelUsed = to;
            },
          }),
        (stdout) => parseComposeDecision(stdout, input.entityId, input.claims.length),
        { onRepair: () => { repairs += 1; } },
      );
      cs?.end('ok');
      const agent: AgentTrace = { via: 'copilot', runtime: 'copilot', model: modelUsed, params: launchFlags(modelUsed), ok: true, ms: Date.now() - t0, at, ...(repairs > 0 ? { repairs } : {}) };
      return { ...decision, agent };
    } catch (e) {
      cs?.end('error');
      throw e;
    }
  };
}
