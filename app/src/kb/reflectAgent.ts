// The thin Reflect agent (SPEC-0024 REFLECT-3) — the rumination cognition over ONE bounded working
// set. Like decompose/connect deciders it is a fresh, disposable single-shot `copilot -p` session
// with NO tools (a single pass, not KB-traversing/multi-hop — so CLI, not the SDK, per #43): it
// returns a JSON verdict of findings and the orchestrator (JobStage) does every effect. There is
// NO fabricating fallback — a bad/absent session throws and the job run is treated as a failed pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectCopilot } from './copilot';

const exec = promisify(execFile);
const COPILOT_TIMEOUT_MS = 120_000;

/** A node in the working set the agent ruminates over (a bounded slice — never the whole KB). */
export interface ReflectNode {
  rel: string; // repo-relative entity node path
  name: string;
  kind: string;
  tags: string[];
  excerpt: string; // a short body excerpt (claims/links block snippet) for context
}

/** What the agent sees: the bounded working set + brief continuity from the journal (JOBS-7). */
export interface ReflectContext {
  workingSet: ReflectNode[];
  journalNotes: string[]; // recent "inspected"/cursor breadcrumbs, oldest→newest
}

/**
 * One thing rumination found. Additive findings carry `writes` (applied on `staging`); destructive
 * ones (retire/merge/consolidate) carry a `review` proposal and NO writes — JobStage routes them by
 * posture (REFLECT-4/5). Mirrors the engine's `JobFinding` minus the runner-owned `proposed` field.
 */
export interface ReflectFinding {
  summary: string; // the what + why (audit; AUTO-8)
  kind: 'additive' | 'destructive';
  confidence: number; // 0..1 — agent-judged (no fixed numeric window in v1, REFLECT-3)
  writes?: { rel: string; content: string }[]; // additive effects (missed claim, emergent-topic node, tag refresh)
  review?: { question: string; detail?: string }; // destructive/low-confidence → Review proposal
}

export interface ReflectResult {
  inspected: string; // what this pass looked at (for audit + journal)
  findings: ReflectFinding[];
}

/** A reflect decider maps a working set to findings. May throw (no fabrication). Injectable for tests. */
export type ReflectDecider = (ctx: ReflectContext) => Promise<ReflectResult>;

/** Injected runner: given the composed prompt, return the session's stdout (tests stub this). */
export type CopilotRunner = (prompt: string) => Promise<string>;

function requestedModel(): string | undefined {
  return process.env.KB_COPILOT_MODEL || undefined;
}
function launchFlags(): string[] {
  const model = requestedModel();
  return model ? ['--no-ask-user', '--model', model] : ['--no-ask-user'];
}
const defaultRunner: CopilotRunner = async (prompt) => {
  const { stdout } = await exec('copilot', ['-p', prompt, ...launchFlags()], { timeout: COPILOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

export const REFLECT_PROMPT_VERSION = 'reflect/v1';

export function buildReflectPrompt(ctx: ReflectContext): string {
  const nodeLines = ctx.workingSet.map(
    (n) => `  - rel: ${n.rel}  name: ${JSON.stringify(n.name)}  kind: ${n.kind}  tags: ${JSON.stringify(n.tags)}  excerpt: ${JSON.stringify(n.excerpt)}`,
  );
  const journalLines = ctx.journalNotes.length > 0 ? ctx.journalNotes.map((j) => `  - ${j}`) : ['  (first run / none)'];
  return [
    'You are the KB-App Reflect librarian doing one RUMINATION pass over a BOUNDED slice of the KB',
    '(NOT the whole KB). Look ONLY at the working set below and find what the forward pipeline missed',
    'or what has gone stale: missed claims, missing/lost connections, emergent topics (recurring',
    'themes with no node yet), stale derived metadata (tags), and low-traction topics.',
    '',
    'Bias toward GROWTH, not shrink. ADDITIVE, high-confidence repairs (add a missed claim, restore a',
    'link, refresh a stale tag, group an emergent topic) → kind "additive" with `writes` (each a',
    'repo-relative path + full file content). Anything DESTRUCTIVE (retire/merge/consolidate/delete a',
    'node) or low-confidence → kind "destructive" with a yes/no `review` {question, detail} and NO',
    'writes — never delete or merge directly. Finding NOTHING is a normal, good outcome (return []).',
    '',
    'Prior runs (for continuity — avoid re-chewing the same ground):',
    ...journalLines,
    '',
    'Working set:',
    ...nodeLines,
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"inspected":"<short note on what you looked at>","findings":[{"summary":"...","kind":"additive|destructive","confidence":0.0,"writes":[{"rel":"...","content":"..."}],"review":{"question":"...","detail":"..."}}]}',
  ].join('\n');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse + validate one session's stdout into a ReflectResult. Tolerates surrounding prose by
 * extracting the first JSON object. Throws on a bad shape — the run is treated as a failed pass and
 * NEVER fabricates a finding (a wrong destructive proposal or bogus write is worse than no-op).
 */
export function parseReflectResult(stdout: string): ReflectResult {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('reflect: no JSON object in output');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  if (!isNonEmptyString(obj.inspected)) throw new Error('reflect: missing inspected');
  if (!Array.isArray(obj.findings)) throw new Error('reflect: findings must be an array');
  const findings = obj.findings.map((f, i): ReflectFinding => {
    if (typeof f !== 'object' || f === null) throw new Error(`reflect: findings[${i}] must be an object`);
    const o = f as Record<string, unknown>;
    if (!isNonEmptyString(o.summary)) throw new Error(`reflect: findings[${i}].summary required`);
    if (o.kind !== 'additive' && o.kind !== 'destructive') throw new Error(`reflect: findings[${i}].kind must be additive|destructive`);
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
      throw new Error(`reflect: findings[${i}].confidence must be a number in [0,1]`);
    }
    const finding: ReflectFinding = { summary: o.summary, kind: o.kind, confidence: o.confidence };
    if (o.writes !== undefined) {
      if (!Array.isArray(o.writes)) throw new Error(`reflect: findings[${i}].writes must be an array`);
      finding.writes = o.writes.map((w, j) => {
        const wo = w as Record<string, unknown>;
        if (!isNonEmptyString(wo?.rel) || typeof wo?.content !== 'string') {
          throw new Error(`reflect: findings[${i}].writes[${j}] must be { rel, content }`);
        }
        return { rel: wo.rel, content: wo.content };
      });
    }
    if (o.review !== undefined) {
      const ro = o.review as Record<string, unknown>;
      if (!isNonEmptyString(ro?.question)) throw new Error(`reflect: findings[${i}].review.question required`);
      finding.review = { question: ro.question, ...(isNonEmptyString(ro.detail) ? { detail: ro.detail } : {}) };
    }
    return finding;
  });
  return { inspected: obj.inspected, findings };
}

export interface ReflectDeciderOptions {
  available?: boolean;
  run?: CopilotRunner;
}

/** Build the production Reflect decider: a fresh Copilot session per pass. Throws when Copilot is
 *  unavailable or the output is bad (the run is a failed pass; no fabrication). */
export function makeReflectDecider(opts: ReflectDeciderOptions = {}): ReflectDecider {
  const run = opts.run ?? defaultRunner;
  let available: boolean | null = opts.available ?? null;
  return async (ctx) => {
    if (available === null) {
      try {
        available = (await detectCopilot()).available;
      } catch {
        available = false;
      }
    }
    if (!available) throw new Error('reflect: copilot unavailable');
    return parseReflectResult(await run(buildReflectPrompt(ctx)));
  };
}
