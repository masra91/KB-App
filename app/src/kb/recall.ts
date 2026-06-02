// Ask & Recall — the "out" pillar core (SPEC-0026). A grounded, cited answer to an NL
// question, produced by a THICK, structure-aware agent that navigates the KB with a
// read-only tool surface — NOT a fixed retrieve-then-synthesize over plain text (ASK-4/5).
//
// Runtime substrate (ASK-12 / ORCH-21,22): the agent runs on the **GitHub Copilot SDK**
// (`@github/copilot-sdk`) — a real multi-turn Session that invokes our tools as native
// typed-tools and streams its answer. The SDK owns the turn loop; WE own the parts that make
// recall trustworthy:
//   - the read-only tool surface (so ASK-3 holds by construction — no write tool exists);
//   - grounding (ASK-7): the agent must finish by calling the `submitAnswer` tool with
//     citations, which we VERIFY resolve on disk before calling the answer grounded;
//   - the budget (F3): tool-call counting in the handler wrappers degrades retrieval past the
//     cap and steers the agent to answer.
// The SDK client is injected (a thin structural seam) so tests drive a fake session that
// scripts tool calls — no real CLI is spawned. Pull-only (ASK-2), ephemeral session (F5).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentTrace } from './archivist';
import { makeReadOnlyTools } from './recallTools';
import { RECALL_SKILL, makeSdkRecallClient } from './recallAgent';

// ── Question / session ──────────────────────────────────────────────────────────────────────

/** One prior exchange in a conversational session (ASK-8). Passed in by the caller (F5). */
export interface RecallTurn {
  question: string;
  answer: string;
}

export interface RecallQuestion {
  question: string;
  history?: RecallTurn[];
}

// ── Evidence + answer ─────────────────────────────────────────────────────────────────────

/** A piece of evidence an assertion rests on (ASK-7). `ref` is repo-relative. */
export interface Citation {
  kind: 'entity' | 'claim' | 'source';
  ref: string; // entity node / claim file (file) or source dir
  label?: string; // human label: entity name, claim statement excerpt, …
}

export interface AskResult {
  question: string;
  /** Markdown answer; substantive assertions carry inline citation markers (ASK-1/7). */
  answer: string;
  /** Evidence the answer cites — verified to resolve on disk (ASK-7). */
  citations: Citation[];
  /** True iff the answer rests on ≥1 verified KB citation. A bare/inferred answer is `false`. */
  grounded: boolean;
  /** How many read-only retrieval tool calls the run made (transparency / budget). */
  toolCalls: number;
  /** The run hit the budget cap (F3) before the agent answered. */
  truncated: boolean;
  /** ORCH-16 provenance of the agent run. */
  trace?: AgentTrace;
}

// ── Read-only tool surface (ASK-4) ──────────────────────────────────────────────────────────
//
// Every tool READS the KB; none mutates it. Tag/property filters (SPEC-0025 META) and the
// Obsidian CLI accelerator (ASK-9) are intentionally absent until those land — capability-gated,
// added to the registry later without changing the loop.

export interface EntityHit {
  rel: string; // repo-relative path to the entity node
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  confidence: number;
  tags: string[]; // Obsidian Properties/tags (SPEC-0025 META) — surfaced so the agent is metadata-aware
  derivedFrom: string[]; // contributing source dirs (provenance)
}

export interface ClaimHit {
  rel: string; // repo-relative path to the claim file
  id: string;
  subject: string; // repo-relative path to the subject entity node
  status: string; // fact | interpretation | hypothesis | …
  confidence: number;
  statement: string;
  derivedFrom: string[]; // source dir(s) the claim was derived from
  mentions: string[]; // verbatim evidence spans
  relatesTo: string[]; // soft hints to other entities (unresolved names)
}

/** One `[[wikilink]]` edge between nodes (or a claim→entity reference). */
export interface LinkHit {
  from: string; // repo-relative path of the file holding the link
  to: string; // link target (repo-relative path or bare name as written)
}

export interface GrepHit {
  rel: string; // repo-relative path of the matching file
  line: number; // 1-based line number
  text: string; // the matching line (trimmed)
}

export interface RecallTools {
  /** Find entity nodes by name/alias (case-insensitive substring), optionally filtered by kind. */
  entityLookup(args: { query: string; kind?: string; limit?: number }): Promise<EntityHit[]>;
  /** Claims whose subject is the given entity (by node rel-path or by name). */
  claimsForEntity(args: { entity: string; limit?: number }): Promise<ClaimHit[]>;
  /** Outgoing `[[links]]` from an entity's node + incoming backlinks to it across the graph. */
  linkTraversal(args: { entity: string }): Promise<{ outgoing: LinkHit[]; incoming: LinkHit[] }>;
  /** Raw text of an entity node or claim file (for quoting). Null if absent / out of bounds. */
  readNode(args: { rel: string }): Promise<string | null>;
  /** The `source.md` text of a source dir (immutable ground truth, for quotes). */
  readSource(args: { dir: string }): Promise<string | null>;
  /** Lexical fallback: case-insensitive line search over sources/entities/claims. */
  grep(args: { pattern: string; limit?: number }): Promise<GrepHit[]>;
}

/** The read-only retrieval tool names exposed to the agent (kept in sync with RecallTools). */
export const TOOL_NAMES = ['entityLookup', 'claimsForEntity', 'linkTraversal', 'readNode', 'readSource', 'grep'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The tool the agent MUST call to finish: its answer + the evidence it rests on (ASK-7). */
export const SUBMIT_ANSWER_TOOL = 'submitAnswer';

// ── SDK seam (minimal structural view of @github/copilot-sdk, so tests need no real CLI) ─────

/** A tool definition handed to the SDK (mapped to `defineTool` by the production client). */
export interface RecallToolDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>; // raw JSON schema (avoids a direct zod dep)
  handler: (args: unknown, invocation?: unknown) => Promise<unknown> | unknown;
}

export interface RecallSessionConfig {
  model?: string;
  systemMessage?: { mode?: 'append' | 'replace'; content: string };
  tools?: RecallToolDef[];
  allowedTools?: string[];
}

export interface RecallSession {
  /** Send the question and resolve when the agent is idle (it answers via the submitAnswer tool). */
  sendAndWait(prompt: string): Promise<unknown>;
  disconnect?(): Promise<void> | void;
}

export interface RecallClient {
  createSession(config: RecallSessionConfig): Promise<RecallSession>;
  disconnect?(): Promise<void> | void;
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────

export interface RecallOptions {
  /** The Copilot-SDK-backed client. Defaults to the real SDK; tests inject a fake. */
  client?: RecallClient;
  /** Defaults to a read-only tool surface over `root`. */
  tools?: RecallTools;
  /** Model hint passed to the SDK session. */
  model?: string;
  /** Absolute path to the BYOA `copilot` CLI for the default SDK client (BUG #65); resolved by the
   *  main tier (STACK-9). Ignored when a `client` is injected. */
  cliPath?: string;
  /** F3 budget: max read-only retrieval tool calls per question. */
  maxToolCalls?: number;
  /** Injectable clock for deterministic audit timestamps in tests. */
  now?: () => string;
  /** Set false to skip the ASK-11 audit write (tests). Defaults true. */
  audit?: boolean;
}

export const DEFAULT_MAX_TOOL_CALLS = 12;

const nowIso = (): string => new Date().toISOString();
const erasedClock = (): string => nowIso();

/** Mutable capture of the agent's final answer (set by the submitAnswer tool). */
interface Captured {
  answered: boolean;
  answer: string;
  citations: Citation[];
  declaredGrounded: boolean;
}

/**
 * Run one grounded recall (SPEC-0026 ASK-1) on the Copilot SDK. Registers the read-only tools +
 * a `submitAnswer` tool, opens a Session with the recall skill as its system message, and sends
 * the question; the SDK drives the multi-turn tool loop. We then VERIFY the submitted citations
 * resolve on disk before calling the answer grounded (ASK-7), enforce the tool-call budget in the
 * handler wrappers (F3), and emit a transparency audit event (ASK-11). Read-only w.r.t. the
 * ontology (ASK-3): only read tools are registered. Never throws at the caller — agent/runtime
 * failure yields an honest, ungrounded result.
 */
export async function recall(root: string, q: RecallQuestion | string, opts: RecallOptions = {}): Promise<AskResult> {
  root = path.resolve(root);
  const question = typeof q === 'string' ? q : q.question;
  const history = (typeof q === 'string' ? undefined : q.history) ?? [];
  const tools = opts.tools ?? makeReadOnlyTools(root);
  const client = opts.client ?? makeSdkRecallClient({ model: opts.model, cliPath: opts.cliPath });
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const clock = opts.now ?? erasedClock;

  const budget = { used: 0, truncated: false };
  const captured: Captured = { answered: false, answer: '', citations: [], declaredGrounded: true };
  const toolDefs = buildRecallToolDefs(tools, captured, budget, maxToolCalls);

  let trace: AgentTrace;
  let result: AskResult | null = null;
  try {
    const session = await client.createSession({
      model: opts.model,
      systemMessage: { mode: 'append', content: RECALL_SKILL },
      tools: toolDefs,
      allowedTools: [...TOOL_NAMES, SUBMIT_ANSWER_TOOL],
    });
    try {
      await session.sendAndWait(buildUserPrompt(question, history));
    } finally {
      await session.disconnect?.();
    }
    trace = { via: 'copilot', runtime: 'copilot', ok: captured.answered, at: clock() };
  } catch (err) {
    // SDK/CLI unavailable or session error — honest, ungrounded result; never fabricate (ORCH-7).
    result = {
      question,
      answer: `I couldn't run recall: ${err instanceof Error ? err.message : String(err)}`,
      citations: [],
      grounded: false,
      toolCalls: budget.used,
      truncated: budget.truncated,
      trace: { via: 'copilot', ok: false, error: err instanceof Error ? err.message : String(err), at: clock() },
    };
  }

  if (!result) {
    const citations = captured.answered ? await verifyCitations(root, tools, captured.citations) : [];
    result = {
      question,
      answer: captured.answered ? captured.answer : 'I could not reach a grounded answer within the retrieval budget.',
      citations,
      grounded: citations.length > 0 && captured.declaredGrounded,
      toolCalls: budget.used,
      truncated: budget.truncated || !captured.answered,
      trace: trace!,
    };
  }

  if (opts.audit !== false) await writeRecallAudit(root, result, toolDefs, clock());
  return result;
}

/** The user-turn prompt: the question plus any prior conversation (ASK-8). The skill is the system message. */
function buildUserPrompt(question: string, history: RecallTurn[]): string {
  const convo = history.length > 0 ? history.map((h) => `Q: ${h.question}\nA: ${h.answer}`).join('\n') + '\n\n' : '';
  return `${convo}Question: ${question}\n\nRetrieve from the KB, then finish by calling ${SUBMIT_ANSWER_TOOL} with your grounded answer and citations.`;
}

/**
 * Build the SDK tool definitions: each read-only retrieval tool wrapped with budget accounting
 * (F3), plus the `submitAnswer` tool that captures the agent's final answer + citations (ASK-7).
 * Exported for unit testing the wrappers directly.
 */
export function buildRecallToolDefs(
  tools: RecallTools,
  captured: Captured,
  budget: { used: number; truncated: boolean },
  maxToolCalls: number,
): RecallToolDef[] {
  const retrieval = (name: ToolName, description: string, parameters: Record<string, unknown>): RecallToolDef => ({
    name,
    description,
    parameters,
    handler: async (rawArgs) => {
      if (budget.used >= maxToolCalls) {
        budget.truncated = true;
        return `Retrieval budget exhausted (${maxToolCalls} calls). Do not call more retrieval tools — call ${SUBMIT_ANSWER_TOOL} now with your best grounded answer.`;
      }
      budget.used++;
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await (tools[name] as (a: any) => Promise<unknown>)(args);
      return JSON.stringify(out ?? null);
    },
  });

  const defs: RecallToolDef[] = [
    retrieval('entityLookup', 'Find entity nodes by name/alias; optional kind filter.', {
      type: 'object',
      properties: { query: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    }),
    retrieval('claimsForEntity', 'Claims about an entity (by node rel-path or name).', {
      type: 'object',
      properties: { entity: { type: 'string' }, limit: { type: 'number' } },
      required: ['entity'],
    }),
    retrieval('linkTraversal', 'Outgoing [[links]] + incoming backlinks for an entity.', {
      type: 'object',
      properties: { entity: { type: 'string' } },
      required: ['entity'],
    }),
    retrieval('readNode', 'Raw text of an entity or claim file (for exact quotes).', {
      type: 'object',
      properties: { rel: { type: 'string' } },
      required: ['rel'],
    }),
    retrieval('readSource', 'The source.md text of a source dir (ground-truth quotes).', {
      type: 'object',
      properties: { dir: { type: 'string' } },
      required: ['dir'],
    }),
    retrieval('grep', 'Case-insensitive line search across sources/entities/claims.', {
      type: 'object',
      properties: { pattern: { type: 'string' }, limit: { type: 'number' } },
      required: ['pattern'],
    }),
    {
      name: SUBMIT_ANSWER_TOOL,
      description: 'Finish: submit the grounded markdown answer and the evidence it cites.',
      parameters: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          grounded: { type: 'boolean' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { kind: { type: 'string', enum: ['entity', 'claim', 'source'] }, ref: { type: 'string' }, label: { type: 'string' } },
              required: ['kind', 'ref'],
            },
          },
        },
        required: ['answer'],
      },
      handler: (rawArgs) => {
        const a = (rawArgs ?? {}) as { answer?: unknown; grounded?: unknown; citations?: unknown };
        captured.answered = true;
        captured.answer = typeof a.answer === 'string' ? a.answer : '';
        captured.declaredGrounded = a.grounded !== false;
        captured.citations = Array.isArray(a.citations)
          ? a.citations.map(asCitation).filter((c): c is Citation => c !== null)
          : [];
        return 'Answer recorded.';
      },
    },
  ];
  return defs;
}

function asCitation(x: unknown): Citation | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if ((o.kind !== 'entity' && o.kind !== 'claim' && o.kind !== 'source') || typeof o.ref !== 'string') return null;
  return { kind: o.kind, ref: o.ref, label: typeof o.label === 'string' ? o.label : undefined };
}

/** Keep only citations that actually resolve on disk — the grounding guarantee (ASK-7). */
async function verifyCitations(root: string, tools: RecallTools, citations: Citation[]): Promise<Citation[]> {
  const out: Citation[] = [];
  for (const c of citations) {
    if (!c || typeof c.ref !== 'string') continue;
    const exists =
      c.kind === 'source' ? (await tools.readSource({ dir: c.ref })) !== null : (await tools.readNode({ rel: c.ref })) !== null;
    if (exists) out.push({ kind: c.kind, ref: c.ref, label: c.label });
  }
  return out;
}

/** ASK-11: append a transparency event recording the question, retrieval, and answer summary.
 *  Lives under the gitignored, never-promoted working zone `.kb/cache/ask/` (CANON-8/9): recall
 *  runs against the vault ROOT (the `main` checkout Obsidian browses), so writing it anywhere
 *  tracked would leave that checkout perpetually git-dirty with non-evergreen machinery state. */
async function writeRecallAudit(root: string, result: AskResult, toolDefs: RecallToolDef[], ts: string): Promise<void> {
  const dir = path.join(root, '.kb', 'cache', 'ask');
  const line =
    JSON.stringify({
      ts,
      event: 'recall',
      runtime: 'copilot-sdk',
      question: result.question,
      toolCalls: result.toolCalls,
      tools: toolDefs.filter((t) => t.name !== SUBMIT_ANSWER_TOOL).map((t) => t.name),
      citations: result.citations.map((c) => `${c.kind}:${c.ref}`),
      grounded: result.grounded,
      truncated: result.truncated,
      agent: result.trace,
    }) + '\n';
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'audit.jsonl'), line);
  } catch {
    /* audit is best-effort transparency; never fail a recall on it */
  }
}

// Re-export so callers get the loop + the default tool surface from one module.
export { makeReadOnlyTools };
