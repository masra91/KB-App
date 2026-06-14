// The thin Connect agent (SPEC-0020 CONNECT-5, reusing the SPEC-0014 harness pattern).
// Each CANDIDATE SET (one block key) gets a fresh, disposable single-shot `copilot -p`
// session (ORCH-5) with NO tools: it returns a JSON verdict and the orchestrator does every
// effect (CONNECT-5). Mirrors decomposeAgent.ts so the harness is reused, not reinvented.
//
// Like Decompose, there is NO fabricating fallback: a bad/absent session must NOT invent a
// resolution (a wrong merge conflates two real things — worse than a wrong claim). On any
// failure the decider throws, and the stage treats it as a failed attempt (retry, then set
// aside; CONNECT-14 / ORCH-12).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCopilotSlot } from './copilotConcurrency';
import { detectCopilot } from './copilot';
import { resolveCopilotModel } from './copilotModel';
import { runWithModelFallback } from './copilotLaunch';
import { parseConnectDecision, type Candidate, type ConnectDecision } from './connect';
import type { AgentTrace } from './archivist';
import { COPILOT_OP, type SpanCtx } from './tracing';

const exec = promisify(execFile);
const COPILOT_TIMEOUT_MS = 120_000;

/** A minimal view of an existing canonical node that blocks to the same key (for fold-in). */
export interface ExistingNodeRef {
  id: string; // the node's stable id (frontmatter `id`)
  name: string; // its current canonical name
}

/** A durable prior verdict on a pair of same-block existing nodes (REVIEW-18 / CONNECT-21). */
export interface PriorDisambiguation {
  a: string; // existingNodeId
  b: string; // existingNodeId
  verdict: 'same' | 'distinct';
}

/** One bounded candidate set the agent resolves (CONNECT-4): all share `blockKey`. */
export interface CandidateSet {
  blockKey: string;
  kind: string;
  candidates: Candidate[]; // the unresolved candidates in this block (≥1)
  existingNodes: ExistingNodeRef[]; // already-canonical nodes with the same block key (may be empty)
  /**
   * Durable decisions already made about pairs of the existing nodes above (REVIEW-18). The matcher
   * must RESOLVE against these, not re-open them: a `distinct` pair is settled-separate, a `same` pair
   * is one node. Do NOT raise a review for a pair listed here — it has already been decided (CONNECT-21).
   */
  priorDecisions?: PriorDisambiguation[];
  /**
   * Map of candidate `sourceId` → the source's HUMAN TITLE (PRIN-24 / "never surface ULIDs"). The
   * prompt references a candidate's source by this title, NEVER the raw ULID — the model can only echo
   * what it is given, and feeding it the raw id is exactly why source ULIDs leaked into disambiguation
   * glosses. The stage resolves these (deriveSourceTitle), so a value is always a human label, never an
   * id; an absent entry falls back to a neutral label, still never the ULID.
   */
  sourceTitles?: Record<string, string>;
}

/** A decider maps a candidate set to a validated verdict. May throw (CONNECT-14). */
export type ConnectDecider = (set: CandidateSet, ctx?: SpanCtx) => Promise<ConnectDecision>;

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
  }, { stage: 'connect' }); // SCALE-3: tag the stage so the ceiling reserves it a slot

/** The versioned per-stage instruction template (SPEC-0014 Q9 / SPEC-0020 §3.3). */
export const CONNECT_PROMPT_VERSION = 'connect/v1';

export function buildConnectPrompt(set: CandidateSet): string {
  // PRIN-24 / "never surface ULIDs": reference each candidate's source by its HUMAN TITLE, never the
  // raw source ULID. The model only echoes what it is given — feeding `source: <ULID>` is exactly why
  // a raw id leaked into the disambiguation gloss. `sourceTitles` (sourceId → title) is resolved by the
  // stage and never holds an id; an absent entry collapses to a neutral label, still never the ULID.
  const candidateLines = set.candidates.map((c) => {
    const title = set.sourceTitles?.[c.sourceId]?.trim();
    return `  - id: ${c.id}  name: ${JSON.stringify(c.name)}  source: ${JSON.stringify(title || 'untitled source')}  mentions: ${JSON.stringify(c.mentions)}`;
  });
  const existingLines =
    set.existingNodes.length > 0
      ? set.existingNodes.map((n) => `  - existingNodeId: ${n.id}  name: ${JSON.stringify(n.name)}`)
      : ['  (none)'];
  // REVIEW-18 / CONNECT-21: decisions already made about pairs of the existing nodes — resolve against
  // them, NEVER re-ask. `distinct` = settled-separate (two real things sharing a name); `same` = one node.
  const priorDecisionLines =
    set.priorDecisions && set.priorDecisions.length > 0
      ? set.priorDecisions.map((d) => `  - ${d.a} and ${d.b}: ALREADY DECIDED ${d.verdict.toUpperCase()} — do NOT raise a review for this pair`)
      : null;
  return [
    'You are the KB-App Connect librarian. ENTITY RESOLUTION: decide which of these',
    `per-source candidate mentions (all loosely grouped as kind "${set.kind}") refer to the`,
    'SAME real-world thing. The grouping is deliberately loose — it may over-group. SPLIT it',
    'into one CLUSTER per distinct real thing.',
    '',
    'For each cluster give: canonicalName (the best human name for the node), the',
    'memberCandidateIds it contains, a confidence in [0,1], and — if the cluster is the same',
    'thing as one of the existing nodes below — that node\'s existingNodeId (to fold into it).',
    'EVERY candidate id below MUST appear in exactly one cluster.',
    '',
    'Do NOT merge things that are merely similar — when two mentions are genuinely ambiguous',
    '(e.g. "S. Jobs" could be a different person), keep them in SEPARATE clusters and raise a',
    'review instead of guessing. A wrong merge conflates two real things.',
    '',
    `blockKey: ${set.blockKey}`,
    `kind: ${set.kind}`,
    'CANDIDATES:',
    ...candidateLines,
    'EXISTING NODES (same block — fold a cluster into one only if truly the same thing):',
    ...existingLines,
    ...(priorDecisionLines
      ? ['ALREADY-DECIDED PAIRS (durable verdicts — resolve against these, NEVER re-ask):', ...priorDecisionLines]
      : []),
    '',
    'Optionally add reviews[] for genuinely ambiguous merges — the affected candidates are',
    'parked, not merged, until answered. For each such review you MUST make the candidates',
    'tellable apart so a human can decide WITHOUT re-reading the sources (REVIEW-16):',
    '  - candidates[]: for EACH affected candidate, give its id (from CANDIDATES above) and a',
    '    one-line "gloss" — what makes THIS one this one: its source context, strongest claim,',
    '    or timeframe (e.g. "from the fishing-trip notes, May 2026" vs "Dave\'s wedding guest',
    '    list"). You hold every candidate\'s mentions + source — author the gloss from them.',
    '  - Refer to a source by the human TITLE shown in its "source:" field above, NEVER a raw id.',
    '    The question and every gloss MUST contain NO opaque ids (ULIDs) — they are meaningless to a',
    '    human and break the "never surface an internal id" promise (PRIN-24).',
    '  - the question itself MUST use those glosses, NOT bare names — a bare "Is Benton the same',
    '    as Benton?" is undecidable. e.g. "Is Benton (fishing-trip notes) the same person as',
    '    Benton (Dave\'s wedding list)?"',
    '  - when the ambiguity is between two EXISTING NODES above (e.g. two same-named nodes that may',
    '    or may not be one), add "pair":["<existingNodeIdA>","<existingNodeIdB>"] — the verdict is then',
    '    remembered durably for that pair so you are never asked about it again (REVIEW-18).',
    'Optionally add signals[] (typed notes for the audit log only; type is open — note,',
    'possible-duplicate, ambiguity, suggestion). Both are optional and usually unnecessary.',
    '',
    'Do NOT create typed links or resolve relationships — only entity resolution here.',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"blockKey":"<the key above>","clusters":[{"canonicalName":"...","memberCandidateIds":["..."],"existingNodeId":"...","confidence":0.0}],"reviews":[{"question":"...","detail":"...","candidates":[{"id":"<candidate id>","gloss":"..."}],"pair":["<existingNodeIdA>","<existingNodeIdB>"],"refs":["..."]}],"signals":[{"type":"...","note":"...","refs":["..."]}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ConnectDeciderOptions {
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
 * Build the production Connect decider: a fresh Copilot session per candidate set. THROWS
 * when Copilot is unavailable or the output is bad — the stage retries and, after K attempts,
 * sets the block aside (CONNECT-14). Stamps an ORCH-16 AgentTrace onto the returned verdict.
 * The verdict is validated to PARTITION exactly the candidate ids in the set (connect.ts).
 */
export function makeConnectDecider(opts: ConnectDeciderOptions = {}): ConnectDecider {
  const run = opts.run ?? defaultRunner;
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  let available: boolean | null = opts.available ?? null;
  return async (set, ctx) => {
    if (available === null) {
      try {
        available = (await detectCopilot()).available;
      } catch {
        available = false;
      }
    }
    if (!available) throw new Error('connect: copilot unavailable');

    // ORCH-16: `modelUsed` starts at the pin and is rewritten to `auto` if the pinned id is rejected
    // and we fall back — so the trace records the model that ACTUALLY ran (a silent pin-drift is visible).
    let modelUsed = resolveCopilotModel(undefined, 'connect'); // SPEC-0048: per-agent pin, else global
    const at = new Date().toISOString();
    const t0 = Date.now();
    const ids = set.candidates.map((c) => c.id);
    // OBS-13: time the Copilot call as a child of the stage's run span (failures included).
    const cs = ctx?.span?.child(COPILOT_OP);
    try {
      const decision = parseConnectDecision(
        await runWithModelFallback((m) => run(buildConnectPrompt(set), cwd, m), { agentKey: 'connect', onFallback: (_from, to) => { modelUsed = to; } }),
        set.blockKey,
        ids,
      );
      cs?.end('ok');
      const agent: AgentTrace = { via: 'copilot', runtime: 'copilot', model: modelUsed, params: launchFlags(modelUsed), ok: true, ms: Date.now() - t0, at };
      return { ...decision, agent };
    } catch (e) {
      cs?.end('error');
      throw e;
    }
  };
}
