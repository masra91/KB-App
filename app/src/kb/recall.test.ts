// SPEC-0026 slice 1 — the recall orchestration over the Copilot SDK (ASK-1,3,5,7,11), headless.
// The SDK client is faked: its session runs a SCRIPTED sequence of tool calls against the tools
// recall.ts registered (simulating the agent), ending with submitAnswer — no real CLI is spawned.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir, pathExists, makeTempDir } from '../../test/tempVault';
import { recall, makeReadOnlyTools, buildRecallToolDefs, recallBudget, countEntityNodes, RECALL_BUDGET, finalizeCitations, type RecallClient, type RecallSessionConfig, type Citation } from './recall';
import { createKb } from './vault';

interface ScriptStep {
  tool: string;
  args: unknown;
}

/** A fake Copilot-SDK client: drives the registered tool handlers per a script. */
function fakeClient(script: ScriptStep[]): { client: RecallClient; calls: string[]; lastConfig: () => RecallSessionConfig | null } {
  const calls: string[] = [];
  let captured: RecallSessionConfig | null = null;
  const client: RecallClient = {
    async createSession(config) {
      captured = config;
      const byName = new Map((config.tools ?? []).map((t) => [t.name, t]));
      return {
        async sendAndWait(): Promise<unknown> {
          for (const step of script) {
            const tool = byName.get(step.tool);
            if (!tool) continue;
            calls.push(step.tool);
            await tool.handler(step.args, {});
          }
          return { type: 'assistant.message' };
        },
        async disconnect(): Promise<void> {},
      };
    },
    async disconnect(): Promise<void> {},
  };
  return { client, calls, lastConfig: () => captured };
}

const fixedNow = (): string => '2026-06-02T00:00:00.000Z';

describe('recall loop on the Copilot SDK (SPEC-0026 slice 1)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('grounded, cited answer via multi-hop tool calls (ASK-1/5/7) + audit (ASK-11)', async () => {
    v = await buildRecallVault();
    const { client, calls, lastConfig } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'claimsForEntity', args: { entity: v.adaRel } },
      { tool: 'submitAnswer', args: { answer: 'Ada Lovelace, the first programmer [1].', citations: [{ kind: 'claim', ref: v.claimRel, label: 'first programmer' }], grounded: true } },
    ]);
    const res = await recall(v.root, 'Who was Ada Lovelace?', { client, now: fixedNow });

    expect(res.grounded).toBe(true);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].ref).toBe(v.claimRel);
    expect(res.toolCalls).toBe(2); // submitAnswer is not a retrieval call
    expect(res.truncated).toBe(false);
    expect(res.trace?.ok).toBe(true);
    expect(calls).toEqual(['entityLookup', 'claimsForEntity', 'submitAnswer']);

    // Read-only enforced via the allow-list: only our read tools + submitAnswer are exposed (ASK-3).
    const cfg = lastConfig();
    expect(cfg?.allowedTools).toEqual(['entityLookup', 'claimsForEntity', 'linkTraversal', 'readNode', 'readSource', 'grep', 'submitAnswer']);
    expect(cfg?.systemMessage?.content).toContain('KB-App Recall agent');

    const auditPath = path.join(v.root, '.kb', 'cache', 'ask', 'audit.jsonl');
    const audit = JSON.parse((await fs.readFile(auditPath, 'utf8')).trim());
    expect(audit).toMatchObject({ event: 'recall', runtime: 'copilot-sdk', grounded: true, toolCalls: 2, ts: fixedNow() });
    expect(audit.citations).toContain(`claim:${v.claimRel}`);
  });

  it('drops citations that do not resolve on disk → not grounded (ASK-7 honesty)', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'submitAnswer', args: { answer: 'Made up.', citations: [{ kind: 'claim', ref: 'claims/person/ghost.md' }], grounded: true } },
    ]);
    const res = await recall(v.root, 'q', { client, now: fixedNow });
    expect(res.citations).toEqual([]);
    expect(res.grounded).toBe(false);
  });

  it('enforces the tool-call budget (F3): retrieval degrades past the cap, run is truncated', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'grep', args: { pattern: 'a' } },
      { tool: 'grep', args: { pattern: 'b' } },
      { tool: 'grep', args: { pattern: 'c' } }, // past cap → exhausted nudge, truncated
      { tool: 'submitAnswer', args: { answer: 'Partial.', citations: [] } },
    ]);
    const res = await recall(v.root, 'q', { client, maxToolCalls: 2, now: fixedNow });
    expect(res.toolCalls).toBe(2); // never exceeds the cap
    expect(res.truncated).toBe(true);
    expect(res.grounded).toBe(false);
  });

  it('never throws when the SDK/CLI is unavailable — honest ungrounded result', async () => {
    v = await buildRecallVault();
    const failing: RecallClient = {
      async createSession(): Promise<never> {
        throw new Error('copilot CLI unavailable');
      },
    };
    const res = await recall(v.root, 'q', { client: failing, now: fixedNow });
    expect(res.grounded).toBe(false);
    expect(res.answer).toContain('copilot CLI unavailable');
    expect(res.trace?.ok).toBe(false);
    expect(res.trace?.error).toContain('copilot CLI unavailable');
  });

  it('truncates honestly when the agent never submits an answer', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([{ tool: 'entityLookup', args: { query: 'Ada' } }]); // no submitAnswer
    const res = await recall(v.root, 'q', { client, now: fixedNow });
    expect(res.grounded).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.toolCalls).toBe(1);
  });

  it('is read-only w.r.t. the ontology (ASK-3): no source/entity/claim file changes', async () => {
    v = await buildRecallVault();
    const before = await snapshot(v.root, ['sources', 'entities', 'claims']);
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'grep', args: { pattern: 'engine' } },
      { tool: 'submitAnswer', args: { answer: 'x', citations: [{ kind: 'entity', ref: v.adaRel }], grounded: true } },
    ]);
    await recall(v.root, 'q', { client, now: fixedNow });
    expect(await snapshot(v.root, ['sources', 'entities', 'claims'])).toEqual(before);
  });

  it('uses the default read-only tools + real clock when not injected', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'submitAnswer', args: { answer: 'A', citations: [{ kind: 'entity', ref: v.adaRel }], grounded: true } },
    ]);
    const res = await recall(v.root, 'q', { client }); // no tools, no now → defaults
    expect(res.grounded).toBe(true);
    expect(res.toolCalls).toBe(1);
    const audit = JSON.parse((await fs.readFile(path.join(v.root, '.kb', 'cache', 'ask', 'audit.jsonl'), 'utf8')).trim());
    expect(typeof audit.ts).toBe('string');
  });

  it('skips the audit write when audit:false', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [] } }]);
    await recall(v.root, 'q', { client, now: fixedNow, audit: false });
    expect(await pathExists(path.join(v.root, '.kb', 'cache', 'ask', 'audit.jsonl'))).toBe(false);
  });

  it('buildRecallToolDefs: retrieval wrappers count + serialize, degrade past cap; submitAnswer captures', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const captured = { answered: false, answer: '', citations: [] as Citation[], declaredGrounded: true };
    const budget = { used: 0, truncated: false };
    const defs = buildRecallToolDefs(tools, captured, budget, 1);

    const lookup = defs.find((d) => d.name === 'entityLookup')!;
    const first = await lookup.handler({ query: 'Ada' });
    expect(typeof first).toBe('string'); // serialized JSON the agent reads
    expect(JSON.parse(first as string).some((e: { rel: string }) => e.rel === v!.adaRel)).toBe(true);
    expect(budget.used).toBe(1);

    const second = await lookup.handler({ query: 'Ada' }); // past the cap of 1
    expect(String(second).toLowerCase()).toContain('budget exhausted');
    expect(budget.truncated).toBe(true);
    expect(budget.used).toBe(1); // not incremented past the cap

    const submit = defs.find((d) => d.name === 'submitAnswer')!;
    await submit.handler({ answer: 'hi', citations: [{ kind: 'claim', ref: 'claims/x.md' }], grounded: true });
    expect(captured.answered).toBe(true);
    expect(captured.answer).toBe('hi');
    expect(captured.citations).toHaveLength(1);
  });

  // Regression (CANON-8/9): recall runs against the vault ROOT — the `main` checkout Obsidian
  // browses. Its transparency audit is workflow machinery, not evergreen knowledge, so it must
  // land in the gitignored working zone and leave the tree clean (it previously wrote an
  // untracked `.kb/ask/audit.jsonl`, leaving the user's vault perpetually git-dirty).
  it('a recall run leaves the evergreen working tree clean (CANON-8/9)', async () => {
    const root = await makeTempDir('kb-recall-clean-');
    try {
      // A REAL git-backed vault with the production .gitignore (couples this test to the real
      // ignore template — if `.kb/cache/` ever stops being ignored, this fails).
      const created = await createKb({ path: root, name: 'clean', initGitIfNeeded: true });
      expect(created.ok).toBe(true);
      const git = simpleGit(root);
      expect((await git.status()).isClean()).toBe(true); // baseline: createKb committed everything

      const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
      await recall(root, 'who is Atlas?', { client, now: fixedNow });

      // The audit was written to the gitignored working zone…
      expect(await pathExists(path.join(root, '.kb', 'cache', 'ask', 'audit.jsonl'))).toBe(true);
      // …and NOT to the tracked evergreen root.
      expect(await pathExists(path.join(root, '.kb', 'ask', 'audit.jsonl'))).toBe(false);
      // …so the `main` checkout the Principal browses stays clean (no untracked machinery state).
      expect((await git.status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});

/** Snapshot path→content for every file under the given subdirs (to prove read-only). */
async function snapshot(root: string, subdirs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function rec(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else out[path.relative(root, full)] = await fs.readFile(full, 'utf8');
    }
  }
  for (const s of subdirs) await rec(path.join(root, s));
  return out;
}

// ── Retrieval budget scaling (F3 / dogfood #5) ────────────────────────────────────────────────
describe('recallBudget — scales the tool-call cap to graph size (dogfood #5)', () => {
  it('clamps to MIN for a tiny/empty KB (no over-budget looping)', () => {
    expect(recallBudget(0)).toBe(RECALL_BUDGET.MIN);
    expect(recallBudget(1)).toBe(RECALL_BUDGET.MIN); // 2+ceil(0.5)=3 → clamp up to MIN(4)
    expect(recallBudget(-5)).toBe(RECALL_BUDGET.MIN); // defensive: negative → MIN
  });

  it('scales in the middle (a ~6-node KB lands ~5, not 12 — the dogfood symptom)', () => {
    expect(recallBudget(6)).toBe(5); // 2 + ceil(0.5*6)=5
    expect(recallBudget(10)).toBe(7); // 2 + 5
    expect(recallBudget(6)).toBeLessThan(12); // strictly below the old fixed default
  });

  it('clamps to MAX for a large KB (keeps headroom, never unbounded)', () => {
    expect(recallBudget(28)).toBe(RECALL_BUDGET.MAX); // 2+14=16
    expect(recallBudget(1000)).toBe(RECALL_BUDGET.MAX);
  });

  it('is monotonic non-decreasing in nodeCount', () => {
    let prev = 0;
    for (let n = 0; n <= 40; n++) {
      const b = recallBudget(n);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });
});

describe('countEntityNodes — entity-graph size for the budget', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmTempDir(dir);
  });

  it('counts entities/**/*.md recursively, ignores other trees + dotdirs, 0 when absent', async () => {
    dir = await makeTempDir();
    const root = path.join(dir, 'v');
    await createKb({ path: root, initGitIfNeeded: true });
    expect(await countEntityNodes(root)).toBe(0); // fresh KB: no entity nodes yet

    await fs.mkdir(path.join(root, 'entities', 'person'), { recursive: true });
    await fs.mkdir(path.join(root, 'entities', 'org'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', 'person', 'ada-lovelace.md'), '# Ada');
    await fs.writeFile(path.join(root, 'entities', 'person', 'charles-babbage.md'), '# Charles');
    await fs.writeFile(path.join(root, 'entities', 'org', 'mit.md'), '# MIT');
    await fs.writeFile(path.join(root, 'entities', 'person', 'notes.txt'), 'not md'); // ignored
    await fs.mkdir(path.join(root, 'entities', '.cache'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', '.cache', 'x.md'), 'dotdir ignored'); // ignored
    // a claim file must NOT be counted (entities are the graph nodes, claims are leaves)
    await fs.mkdir(path.join(root, 'claims', 'person'), { recursive: true });
    await fs.writeFile(path.join(root, 'claims', 'person', 'c.md'), '# claim');

    expect(await countEntityNodes(root)).toBe(3);
  });
});

// ── ASK-13: inline numbered citations — verify + dedup + dense renumber ───────────────────────────
describe('finalizeCitations (ASK-13) — dense, deduped, verified [n] ↔ citations[n-1]', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('renumbers inline [n] to be dense + 1:1, deduping a repeated ref to one number', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const raw: Citation[] = [
      { kind: 'claim', ref: v.claimRel },
      { kind: 'entity', ref: v.adaRel },
      { kind: 'claim', ref: v.claimRel }, // duplicate of [1]
    ];
    const { answer, citations } = await finalizeCitations(tools, 'Ada [1] is a programmer [2][3].', raw);
    expect(citations).toHaveLength(2); // dup collapsed
    expect(citations[0].ref).toBe(v.claimRel);
    expect(citations[1].ref).toBe(v.adaRel);
    expect(answer).toBe('Ada [1] is a programmer [2][1].'); // [3] reused [1]'s number
  });

  it('drops a marker whose citation does not resolve, then renumbers the survivors densely (ASK-7)', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const raw: Citation[] = [
      { kind: 'claim', ref: 'claims/person/does-not-exist.md' }, // unresolvable → dropped
      { kind: 'entity', ref: v.adaRel }, // resolvable → becomes [1]
    ];
    const { answer, citations } = await finalizeCitations(tools, 'A [1] and B [2].', raw);
    expect(citations).toHaveLength(1);
    expect(citations[0].ref).toBe(v.adaRel);
    expect(answer).toBe('A  and B [1].'); // [1] dropped (unresolvable), [2] → [1]
  });

  it('flows through recall(): the result carries dense markers + matching citations', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      {
        tool: 'submitAnswer',
        args: {
          answer: 'Ada Lovelace [1] worked on the Analytical Engine [2], and is the first programmer [1].',
          citations: [
            { kind: 'claim', ref: v.claimRel },
            { kind: 'entity', ref: v.engineRel },
          ],
          grounded: true,
        },
      },
    ]);
    const res = await recall(v.root, 'Tell me about Ada', { client, now: fixedNow });
    expect(res.grounded).toBe(true);
    expect(res.citations.map((c) => c.ref)).toEqual([v.claimRel, v.engineRel]);
    expect(res.answer).toContain('[1]');
    expect(res.answer).toContain('[2]');
    // No dangling marker beyond the citation count.
    expect(res.answer).not.toMatch(/\[3\]/);
  });
});
