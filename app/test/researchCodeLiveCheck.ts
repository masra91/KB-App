// Manual LIVE diagnostic for the Code researcher (SPEC-0028 Slice 2a/2b) — NOT a unit test (no
// `.test.ts`, never auto-run; it shells out to git/gh/az). Run it in a BYOA env (git + the user's
// `gh`/`az` auth) to validate the Code template end-to-end on REAL sources, not a stub.
//
//   cd app && \
//     KB_CODE_REPO_PATH=/abs/path/to/local/git/repo \
//     KB_CODE_PR_REPO=owner/name \
//     KB_CODE_AZ_ORG=https://dev.azure.com/yourorg KB_CODE_AZ_PROJECT=Proj KB_CODE_AZ_REPO=repo \
//     node_modules/.bin/vite-node test/researchCodeLiveCheck.ts "search term"
//
// Set whichever sources you want to exercise (any subset): local repo (KB_CODE_REPO_PATH → grep+log),
// GitHub PRs (KB_CODE_PR_REPO → gh), Azure DevOps PRs (KB_CODE_AZ_ORG/PROJECT/REPO → az). It builds a
// `code` ResearcherConfig pinned to those CONFIG targets, runs the production `makeCodeResearchFn`
// (real read-only layers — codeGit/ghRead/azRead), and prints `{found, citations, note}`.
//
// Interpretation:
//   - found:true + real file paths / PR URLs in citations → that source's live read path works.
//   - found:false                                         → no match (or BYOA tool unavailable —
//                                                            gh/az graceful-degrade; check it's authed).
// Egress is bounded to the CONFIG-pinned targets; reads are read-only (codeGit/ghRead/azRead). For the
// ingest-path e2e (secondary source via system-minted ULID + audit), wrap in runResearcher instead.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCodeResearchFn } from '../src/kb/researchCodeAgent';
import type { ResearcherConfig, ResearchRequest } from '../src/kb/researchers';

async function main(): Promise<void> {
  const what = process.argv[2] ?? 'README';
  const config: Record<string, unknown> = {};
  if (process.env.KB_CODE_REPO_PATH) config.repoPath = process.env.KB_CODE_REPO_PATH;
  if (process.env.KB_CODE_PR_REPO) config.prRepo = process.env.KB_CODE_PR_REPO;
  if (process.env.KB_CODE_AZ_ORG) config.azOrg = process.env.KB_CODE_AZ_ORG;
  if (process.env.KB_CODE_AZ_PROJECT) config.azProject = process.env.KB_CODE_AZ_PROJECT;
  if (process.env.KB_CODE_AZ_REPO) config.azRepo = process.env.KB_CODE_AZ_REPO;
  if (Object.keys(config).length === 0) {
    console.error('[code-live-check] set at least one source: KB_CODE_REPO_PATH / KB_CODE_PR_REPO / KB_CODE_AZ_ORG+PROJECT+REPO');
    process.exitCode = 1;
    return;
  }

  // A throwaway vault root for the researcher's isolated clone sandbox (.kb/cache/researchers/<id>).
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-code-livecheck-'));
  const r: ResearcherConfig = {
    id: 'code-live-check',
    template: 'code',
    prompt: 'Research the configured repo / PRs for the requested term.',
    egressTier: 'local-only',
    scope: 'global',
    budget: { maxToolCalls: 8, maxDepth: 2 },
    schedule: 'off',
    posture: 'guarded',
    enabled: true,
    config,
  };
  const req: ResearchRequest = { id: 'live-1', ts: new Date().toISOString(), by: { stage: 'panel' }, what, why: 'live capability check', context: '', dedupKey: `live::${what}` };

  console.log(`[code-live-check] term=${JSON.stringify(what)} sources=${Object.keys(config).join(',')}\n`);
  const out = await makeCodeResearchFn(vault)(r, req);
  console.log(JSON.stringify({ found: out.found, query: out.query, citations: out.citations, noteChars: out.note.length, notePreview: out.note.slice(0, 1000) }, null, 2));
  await fs.rm(vault, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[code-live-check] ERROR:', err);
  process.exitCode = 1;
});
