// OPT-IN enrich-quality dogfood (PM interim, #163 follow-on). NOT a CI gate — a real
// capture→archive→decompose→connect→claims pass with LIVE BYOA copilot deciders, judging the
// user-facing OUTPUT quality on a crafted input designed to exercise:
//   - entity granularity (DECOMP-17): people/orgs are nodes; roles/descriptors are NOT
//   - claim dedup (CLAIMS-19): the same fact restated across sources/entities collapses within-source
//   - wikilinks (CONNECT-12): a claim's relatesTo hint becomes a real [[link]] between nodes
// It LOGS the actual entities + claims + link blocks so a human can judge quality; soft assertions
// only flag gross failures. Skips unless KB_EVAL=1 (real copilot + network, non-deterministic).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../test/tempVault';
import { createKb } from '../src/kb/vault';
import { Orchestrator } from '../src/kb/orchestrator';
import { makeCopilotDecider } from '../src/kb/copilotAgent';
import { Mutex } from '../src/kb/stageLock';
import { ensureStagingWorktree } from '../src/kb/stagingWorktree';
import { promote } from '../src/kb/staging';
import { decomposeOne, readDecomposeQueue } from '../src/kb/decomposeStage';
import { makeDecomposeDecider } from '../src/kb/decomposeAgent';
import { ClaimsStage } from '../src/kb/claimsStage';
import { makeConnectDecider } from '../src/kb/connectAgent';
import { makeClaimsDecider } from '../src/kb/claimsAgent';
import { ConnectStage } from '../src/kb/connectStage';
import { recall } from '../src/kb/recall';
import { resolveCopilotCliPath } from '../src/main/researchWiring';

const RUN = process.env.KB_EVAL === '1';

async function walkFiles(root: string, sub: string, pred: (n: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function w(d: string): Promise<void> {
    let es: import('node:fs').Dirent[];
    try { es = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await w(f);
      else if (e.isFile() && pred(e.name)) out.push(f);
    }
  }
  await w(path.join(root, sub));
  return out;
}

describe.skipIf(!RUN)('enrich e2e dogfood (opt-in; real copilot) — output quality', () => {
  it('capture→decompose→connect→claims: judge granularity, dedup, wikilinks', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      const promoteEvergreen = async (): Promise<void> => { await promote(root); };
      const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen);

      // Crafted to exercise all three axes:
      //  - "Grace Hopper" + "the US Navy" are genuine entities; "rear admiral"/"pioneer" are descriptors (granularity).
      //  - Two sources both assert Hopper worked on COBOL → within-source dedup once merged (dedup).
      //  - Hopper "served in the US Navy" → a relatesTo hint Hopper↔Navy (wikilink).
      await orch.capture('note-1', [{ kind: 'text', text: 'Grace Hopper was a pioneer who worked on COBOL. She served in the US Navy as a rear admiral.' }]);
      await orch.capture('note-2', [{ kind: 'text', text: 'Grace Hopper helped develop COBOL. She was a rear admiral in the US Navy.' }]);
      await orch.poke(); // archive → sources/, queue for decompose

      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, makeDecomposeDecider());
      }
      const connect = new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen);
      await connect.poke();
      // NOTE: claims' afterDrain runs UNDER the canonical-writer lock, so it must NOT `await` a
      // connect drain there (connect's drain needs the same lock → wait-cycle deadlock; pipeline.ts
      // uses `void connect.poke()` precisely for this). So afterDrain just promotes, and we settle the
      // CONNECT-12 link-promotion pass separately at TOP LEVEL (lock-free) after claims drains.
      const claims = new ClaimsStage(stagingWt, makeClaimsDecider(), lock, undefined, promoteEvergreen);
      await claims.poke();
      await connect.poke(); // settle link-promotion (relatesTo → [[wikilinks]]) deterministically

      // ── Observe the actual output (on main) ──
      const entityFiles = await walkFiles(root, 'entities', (n) => n.endsWith('.md'));
      const claimFiles = await walkFiles(root, 'claims', (n) => n.endsWith('.md'));
      console.log(`\n===== ENRICH E2E DOGFOOD OUTPUT =====`);
      console.log(`entities: ${entityFiles.length} | claim files: ${claimFiles.length}`);
      for (const f of entityFiles) {
        console.log(`\n----- ${path.relative(root, f)} -----\n${await fs.readFile(f, 'utf8')}`);
      }
      for (const f of claimFiles) {
        console.log(`\n----- ${path.relative(root, f)} -----\n${await fs.readFile(f, 'utf8')}`);
      }
      console.log(`===== END DOGFOOD OUTPUT =====\n`);

      // Soft floor: the pipeline produced SOME entities (gross-failure guard only; quality is judged from the log).
      expect(entityFiles.length).toBeGreaterThan(0);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('CLAIMS-19 within-source dedup: a relational fact restated per-entity collapses', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      const promoteEvergreen = async (): Promise<void> => { await promote(root); };
      const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen);

      // ONE source whose relationship gets restated from each entity's perspective WITHIN the source:
      // "co-founded Acme Robotics" lands on both Maria and James (same sourceKey) → CLAIMS-19 should
      // collapse the relational restatement to one canonical claim (CLAIMS-17 only forbids CROSS-source
      // dedup; within-source IS deduped).
      await orch.capture('founders', [{ kind: 'text', text: 'Maria Lopez and James Park co-founded Acme Robotics in 2018. Maria Lopez serves as the CEO.' }]);
      await orch.poke();
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, makeDecomposeDecider());
      }
      const connect = new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen);
      await connect.poke();
      const claims = new ClaimsStage(stagingWt, makeClaimsDecider(), lock, undefined, promoteEvergreen);
      await claims.poke();
      await connect.poke(); // settle link-promotion + within-source dedup (CLAIMS-19 runs in connect's drain)

      const entityFiles = await walkFiles(root, 'entities', (n) => n.endsWith('.md'));
      const claimFiles = await walkFiles(root, 'claims', (n) => n.endsWith('.md'));
      console.log(`\n===== CLAIMS-19 DEDUP DOGFOOD OUTPUT =====`);
      console.log(`entities: ${entityFiles.length} | claim files: ${claimFiles.length}`);
      const statements: string[] = [];
      for (const f of claimFiles) {
        const body = await fs.readFile(f, 'utf8');
        const stmt = (body.split('---').pop() || '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
        statements.push(stmt);
        console.log(`  • ${stmt}`);
      }
      // Surface any obvious within-source duplicate statements (same normalized text appearing >1×).
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const counts = new Map<string, number>();
      for (const s of statements) counts.set(norm(s), (counts.get(norm(s)) ?? 0) + 1);
      const dupes = [...counts.entries()].filter(([, n]) => n > 1);
      console.log(`exact-restatement dupes remaining: ${dupes.length ? JSON.stringify(dupes) : 'none'}`);
      console.log(`===== END CLAIMS-19 DEDUP OUTPUT =====\n`);

      expect(entityFiles.length).toBeGreaterThan(0);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('recall: a grounded, cited answer over the enriched KB (ASK-1/7)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      const promoteEvergreen = async (): Promise<void> => { await promote(root); };
      const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen);
      // Build a tiny real KB via the pipeline, then ask a question its claims can ground.
      await orch.capture('note', [{ kind: 'text', text: 'Grace Hopper worked on the COBOL programming language and served in the US Navy.' }]);
      await orch.poke();
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, makeDecomposeDecider());
      }
      const connect = new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen);
      await connect.poke();
      const claims = new ClaimsStage(stagingWt, makeClaimsDecider(), lock, undefined, promoteEvergreen);
      await claims.poke();

      // Recall over `main` (what the user sees). Pass the BYOA cliPath (the #160 seam).
      const res = await recall(root, 'What did Grace Hopper work on?', { cliPath: resolveCopilotCliPath() });
      console.log(`\n===== RECALL DOGFOOD OUTPUT =====`);
      console.log(`grounded: ${res.grounded} | citations: ${res.citations?.length ?? 0}`);
      console.log(`answer: ${res.answer}`);
      console.log(`citations: ${JSON.stringify(res.citations ?? [])}`);
      console.log(`===== END RECALL OUTPUT =====\n`);
      // Soft: recall returned an answer (groundedness judged from the log; SDK availability varies).
      expect(typeof res.answer).toBe('string');
    } finally {
      await rmTempDir(dir);
    }
  });
});
