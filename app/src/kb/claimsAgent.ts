// The thin Claims agent (SPEC-0016 CLAIMS-3, reusing the SPEC-0014 harness pattern). Each
// entity gets a fresh, disposable single-shot `copilot -p` session (ORCH-5/CLAIMS-4) with NO
// tools: it returns a JSON decision and the orchestrator does every effect (CLAIMS-3).
// Mirrors decomposeAgent.ts so the harness is reused, not reinvented (ORCH-9).
//
// Like Decompose (and unlike the archivist), Claims has NO deterministic fallback that
// fabricates output: a bad/absent session must NOT invent claims (that would pollute the
// graph). On any failure the decider throws and the stage treats it as a failed attempt
// (retry, then set aside; CLAIMS-12 / ORCH-12).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCopilotSlot } from './copilotConcurrency';
import { detectCopilot } from './copilot';
import { resolveCopilotModel } from './copilotModel';
import { runWithModelFallback } from './copilotLaunch';
import { runWithSelfRepair, appendRepairInstruction } from './selfRepair';
import { UNTRUSTED_SOURCE_SKILL, UNTRUSTED_SOURCE_DELIMITER_NOTE } from './untrustedSource';
import { parseClaimsDecision, type ClaimsDecision, CLAIM_STATUSES } from './claims';
import type { SourceInput } from './decomposeAgent';
import type { AgentTrace } from './archivist';
import { COPILOT_OP, type SpanCtx } from './tracing';

const exec = promisify(execFile);
const COPILOT_TIMEOUT_MS = 120_000; // reading a whole source for substance takes time

/** A review the Principal has already answered, fed back to a resumed re-run (REVIEW-6). */
export interface AnsweredReview {
  question: string;
  verdict: string; // 'confirm' | 'reject'
  note?: string | null;
}

/** The work item as the agent sees it: ONE entity node + the WHOLE source it derives from
 *  (CLAIMS-5). The agent records what the source asserts ABOUT this entity. */
export interface EntityInput {
  entityId: string;
  kind: string;
  name: string;
  source: SourceInput;
  /** Reviews this entity already had answered (on a resumed run); authoritative (REVIEW-6). */
  priorReviews?: AnsweredReview[];
}

/** A decider maps an entity (+ its source) to a validated claims decision. May throw (CLAIMS-12). */
export type ClaimsDecider = (input: EntityInput, ctx?: SpanCtx) => Promise<ClaimsDecision>;

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
        maxBuffer: 8 * 1024 * 1024,
        cwd,
      });
      return stdout;
    } catch (err) {
      // Surface the subprocess stderr on the error so the stage's dev-log records the real cause (OBS-4).
      const stderr = (err as { stderr?: unknown }).stderr;
      if (err instanceof Error && stderr) err.message += `\n[copilot stderr] ${String(stderr).slice(0, 2000)}`;
      throw err;
    }
  }, { stage: 'claims' }); // SCALE-3: tag the stage so the ceiling reserves it a slot

/** The versioned per-stage instruction template (SPEC-0014 Q9 / SPEC-0016 §3.1), composed
 *  per entity. Signal `type` is an OPEN nudge in prose (CLAIMS-13); claim `status` is a
 *  CLOSED set enforced in code (CLAIMS-8) and stated here so the agent uses it correctly. */
export const CLAIMS_PROMPT_VERSION = 'claims/v1';

export function buildClaimsPrompt(input: EntityInput): string {
  const body =
    input.source.text ?? '(no extractable text — this is an opaque file; infer only from its name/type)';
  return [
    'You are the KB-App Claims librarian. You are given ONE entity (a node already extracted',
    'from a source) and the WHOLE source it was derived from. Record the CLAIMS the source',
    `makes ABOUT THIS ENTITY — assertions, not just its existence. Extract only claims`,
    'grounded in the source text; do NOT invent anything it does not support.',
    '',
    // INTAKE-13 / RESEARCH-12: open-feed source content is untrusted — fence it as DATA, not instructions.
    UNTRUSTED_SOURCE_SKILL,
    '',
    'Each claim is SINGLE-SUBJECT — it is about THIS entity only.',
    '',
    'SUBJECT ATTRIBUTION (critical — get this right):',
    '  - A claim belongs to THIS entity ONLY if the source asserts it ABOUT THIS entity — i.e. THIS',
    '    entity is the grammatical SUBJECT of the assertion (the one who did/is/has the thing).',
    '  - The source may CO-MENTION other people who merely share context with the subject (same',
    '    workplace, same event, named in passing). A co-mentioned person is NOT the subject: do NOT',
    '    attach the subject\'s claims to them. If THIS entity is only co-mentioned and the source',
    '    asserts nothing specifically about THIS entity, the correct answer is EMPTY claims[].',
    '  - FIRST-PERSON narration ("I…", "my…", "we…") refers to the source\'s AUTHOR / narrator /',
    '    protagonist — NOT to anyone else the text happens to name. Attribute first-person claims to',
    '    THIS entity ONLY when THIS entity clearly IS that first-person narrator. A career, history,',
    '    or accomplishment told in the first person does NOT belong to a colleague the narrator mentions.',
    '  - When you cannot tell whether a claim is about THIS entity or about a co-mentioned other, do',
    '    NOT guess — omit it. A claim misattributed to the wrong person silently corrupts their page;',
    '    that is worse than a missing claim.',
    '',
    'For each claim give:',
    `  - statement: a concise assertion about the entity, grounded in the source`,
    `  - status: exactly one of ${CLAIM_STATUSES.join(', ')} (fact = stated/observed;`,
    '      interpretation = a reasonable reading; hypothesis = speculative/uncertain)',
    '  - confidence: a number in [0,1] that the claim is real and correctly parsed',
    '  - mentions[]: verbatim span(s) from the source that evidence the claim',
    '',
    'When a claim\'s statement EXPLICITLY names other entities, you MUST list those names verbatim',
    'in relatesTo[] — this is EXTRACTION of the names the statement mentions (a textual fact), the',
    'breadcrumb a later linking stage resolves. It is NOT a claim of any typed relationship: you',
    'only surface the names, you do not link them.',
    'Do NOT assert relationships as fact, and do not resolve identity across sources.',
    '',
    'Optionally add signals[]: typed notes FOR THE RECORD that are not claims (they go to the',
    'audit log, never the graph). type is an OPEN vocabulary — prefer these:',
    '  note, possible-duplicate, suggestion, conflict, low-quality-source, needs-research',
    'Each signal has: type, note (free text), and optional refs[]. Signals are optional and',
    'usually unnecessary — only add one when it genuinely helps. An entity the source merely',
    'name-drops yields an EMPTY claims[] — that is a valid, expected answer.',
    '',
    'If you genuinely CANNOT decide something on the evidence and must ask the Principal,',
    'raise a REVIEW instead of guessing: reviews[]:[{question, detail, refs?}]. Each review is',
    'ONE yes/no question (e.g. "Is the Steve here the same as Steve Jones?" — never open-ended',
    'like "who is Steve?"), with detail explaining why you ask and what a yes/no means. When',
    'you raise any review, return it INSTEAD of claims for now — your work pauses until the',
    'Principal answers, then you will be re-run with the answer. Use this rarely.',
    '',
    ...(input.priorReviews && input.priorReviews.length > 0
      ? [
          'The Principal has ALREADY answered these questions — treat the answers as authoritative:',
          ...input.priorReviews.map(
            (r) => `  • Q: ${r.question}  → ${r.verdict.toUpperCase()}${r.note ? ` (note: ${r.note})` : ''}`,
          ),
          'Proceed using these answers; do not re-ask the same question.',
          '',
        ]
      : []),
    `entityId: ${input.entityId}`,
    `entity.kind: ${input.kind}`,
    `entity.name: ${input.name}`,
    `sourceId: ${input.source.sourceId}`,
    UNTRUSTED_SOURCE_DELIMITER_NOTE,
    body,
    '--- SOURCE END ---',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"entityId":"<the id above>","claims":[{"statement":"...","status":"fact","confidence":0.0,"mentions":["..."],"relatesTo":["..."]}],"signals":[{"type":"...","note":"...","refs":["..."]}],"reviews":[{"question":"...","detail":"...","refs":["..."]}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ClaimsDeciderOptions {
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
 * Build the production Claims decider: a fresh Copilot session per entity. THROWS when
 * Copilot is unavailable or the output is bad — the stage retries and, after K attempts,
 * sets the entity aside (CLAIMS-12). Stamps an ORCH-16 AgentTrace onto the returned decision.
 */
export function makeClaimsDecider(opts: ClaimsDeciderOptions = {}): ClaimsDecider {
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
    if (!available) throw new Error('claims: copilot unavailable');

    // ORCH-16: `modelUsed` starts at the pin and is rewritten to `auto` if the pinned id is rejected
    // and we fall back — so the trace records the model that ACTUALLY ran (a silent pin-drift is visible).
    let modelUsed = resolveCopilotModel(undefined, 'claims'); // SPEC-0048: per-agent pin, else global
    const at = new Date().toISOString();
    const t0 = Date.now();
    // OBS-13: time the Copilot call as a child of the stage's run span (failures included).
    const cs = ctx?.span?.child(COPILOT_OP);
    // HEAL-1: self-repair wraps the launch — on a parse/validation failure, re-prompt with the error
    // fed back (bounded). A launch/timeout/systemic error from `run` is NOT a parse error and
    // propagates so the stage's set-aside + #256 breaker still see it (HEAL-6 boundary).
    const basePrompt = buildClaimsPrompt(input);
    let repairs = 0;
    try {
      const { value: decision } = await runWithSelfRepair(
        (repair) =>
          runWithModelFallback((m) => run(repair ? appendRepairInstruction(basePrompt, repair) : basePrompt, cwd, m), {
            agentKey: 'claims',
            onFallback: (_from, to) => {
              modelUsed = to;
            },
          }),
        (stdout) => parseClaimsDecision(stdout, input.entityId),
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
