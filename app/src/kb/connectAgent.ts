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

/** One bounded candidate set the agent resolves (CONNECT-4): all share `blockKey`. */
export interface CandidateSet {
  blockKey: string;
  kind: string;
  candidates: Candidate[]; // the unresolved candidates in this block (≥1)
  existingNodes: ExistingNodeRef[]; // already-canonical nodes with the same block key (may be empty)
}

/** A decider maps a candidate set to a validated verdict. May throw (CONNECT-14). */
export type ConnectDecider = (set: CandidateSet, ctx?: SpanCtx) => Promise<ConnectDecision>;

/** Injectable runner: given the composed prompt, return the session's stdout. */
export type CopilotRunner = (prompt: string) => Promise<string>;

function requestedModel(): string | undefined {
  return process.env.KB_COPILOT_MODEL || undefined;
}

/** Launch flags (excludes `-p <prompt>`); recorded verbatim in the AgentTrace (ORCH-16). */
function launchFlags(): string[] {
  const model = requestedModel();
  return model ? ['--no-ask-user', '--model', model] : ['--no-ask-user'];
}

const defaultRunner: CopilotRunner = async (prompt) =>
  // Acquire one global copilot slot so concurrent (cap>1) stage drains can't fan out past the
  // process-wide ceiling (dogfood #4 / copilotConcurrency).
  withCopilotSlot(async () => {
    try {
      const { stdout } = await exec('copilot', ['-p', prompt, ...launchFlags()], {
        timeout: COPILOT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      // Surface the subprocess stderr on the error so the stage's dev-log records the real cause (OBS-4).
      const stderr = (err as { stderr?: unknown }).stderr;
      if (err instanceof Error && stderr) err.message += `\n[copilot stderr] ${String(stderr).slice(0, 2000)}`;
      throw err;
    }
  });

/** The versioned per-stage instruction template (SPEC-0014 Q9 / SPEC-0020 §3.3). */
export const CONNECT_PROMPT_VERSION = 'connect/v1';

export function buildConnectPrompt(set: CandidateSet): string {
  const candidateLines = set.candidates.map(
    (c) => `  - id: ${c.id}  name: ${JSON.stringify(c.name)}  source: ${c.sourceId}  mentions: ${JSON.stringify(c.mentions)}`,
  );
  const existingLines =
    set.existingNodes.length > 0
      ? set.existingNodes.map((n) => `  - existingNodeId: ${n.id}  name: ${JSON.stringify(n.name)}`)
      : ['  (none)'];
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
    '',
    'Optionally add reviews[] for genuinely ambiguous merges — the affected candidates are',
    'parked, not merged, until answered. For each such review you MUST make the candidates',
    'tellable apart so a human can decide WITHOUT re-reading the sources (REVIEW-16):',
    '  - candidates[]: for EACH affected candidate, give its id (from CANDIDATES above) and a',
    '    one-line "gloss" — what makes THIS one this one: its source context, strongest claim,',
    '    or timeframe (e.g. "from the fishing-trip notes, May 2026" vs "Dave\'s wedding guest',
    '    list"). You hold every candidate\'s mentions + source — author the gloss from them.',
    '  - the question itself MUST use those glosses, NOT bare names — a bare "Is Benton the same',
    '    as Benton?" is undecidable. e.g. "Is Benton (fishing-trip notes) the same person as',
    '    Benton (Dave\'s wedding list)?"',
    'Optionally add signals[] (typed notes for the audit log only; type is open — note,',
    'possible-duplicate, ambiguity, suggestion). Both are optional and usually unnecessary.',
    '',
    'Do NOT create typed links or resolve relationships — only entity resolution here.',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"blockKey":"<the key above>","clusters":[{"canonicalName":"...","memberCandidateIds":["..."],"existingNodeId":"...","confidence":0.0}],"reviews":[{"question":"...","detail":"...","candidates":[{"id":"<candidate id>","gloss":"..."}],"refs":["..."]}],"signals":[{"type":"...","note":"...","refs":["..."]}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ConnectDeciderOptions {
  /** Force availability (skips detection). Tests set this; production detects lazily. */
  available?: boolean;
  /** Injected runner (tests). Defaults to shelling out to `copilot -p`. */
  run?: CopilotRunner;
}

/**
 * Build the production Connect decider: a fresh Copilot session per candidate set. THROWS
 * when Copilot is unavailable or the output is bad — the stage retries and, after K attempts,
 * sets the block aside (CONNECT-14). Stamps an ORCH-16 AgentTrace onto the returned verdict.
 * The verdict is validated to PARTITION exactly the candidate ids in the set (connect.ts).
 */
export function makeConnectDecider(opts: ConnectDeciderOptions = {}): ConnectDecider {
  const run = opts.run ?? defaultRunner;
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

    const model = requestedModel() ?? 'default';
    const params = launchFlags();
    const at = new Date().toISOString();
    const t0 = Date.now();
    const ids = set.candidates.map((c) => c.id);
    // OBS-13: time the Copilot call as a child of the stage's run span (failures included).
    const cs = ctx?.span?.child(COPILOT_OP);
    try {
      const decision = parseConnectDecision(await run(buildConnectPrompt(set)), set.blockKey, ids);
      cs?.end('ok');
      const agent: AgentTrace = { via: 'copilot', runtime: 'copilot', model, params, ok: true, ms: Date.now() - t0, at };
      return { ...decision, agent };
    } catch (e) {
      cs?.end('error');
      throw e;
    }
  };
}
