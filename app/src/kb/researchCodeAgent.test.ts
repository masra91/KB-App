// The Code researcher cognition (SPEC-0028 RESEARCH-10/16, Slice 2a pt2). Exercised against a REAL
// local temp repo (git required; skipped if absent) — the finding is real repo data, never synthetic.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { makeCodeResearchFn, codeRepoSourceOf, codePrRepoOf, parsePrList, prMatchesTerm, buildPrNote, codeAzTargetOf, parseAzPrList, azPrMatchesTerm, buildAzPrNote, countAttributedCodeFacts, filterCodeCitations, buildCandidateSet, isIgnoredRepoPath, makeCodeRepoReader, MAX_FILE_READ_BYTES, MAX_CANDIDATE_FILES, CODE_RESEARCH_SKILL, type GhReadFn, type AzReadFn, type CodeSdkSession } from './researchCodeAgent';
import { researcherWorkspace } from './codeGit';
import type { ResearcherConfig, ResearchRequest } from './researchers';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const code = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({
  id: 'code-1', template: 'code', prompt: 'p', egressTier: 'local-only', scope: 'global',
  budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true, ...over,
});
const req = (what: string): ResearchRequest => ({ id: 'r1', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose' }, what, why: 'unknown', context: '', dedupKey: 'k' });

async function makeRepo(dir: string, files: Record<string, string>): Promise<string> {
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const g = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 'T']);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), content);
  }
  g(['add', '.']);
  g(['commit', '-q', '-m', 'initial commit']);
  return repo;
}

describe('codeRepoSourceOf', () => {
  it('reads config.repoPath; null when absent/blank', () => {
    expect(codeRepoSourceOf(code({ config: { repoPath: '/abs/repo' } }))).toBe('/abs/repo');
    expect(codeRepoSourceOf(code({ config: {} }))).toBeNull();
    expect(codeRepoSourceOf(code({ config: { repoPath: '   ' } }))).toBeNull();
    expect(codeRepoSourceOf(code())).toBeNull();
  });
});

describe('codePrRepoOf — CONFIG-pinned, validated repo (KB-QD 2b gate)', () => {
  it('reads a valid config.prRepo; rejects flag-like/garbage → null (never an LLM-supplied repo)', () => {
    expect(codePrRepoOf(code({ config: { prRepo: 'octocat/hello-world' } }))).toBe('octocat/hello-world');
    expect(codePrRepoOf(code({ config: { prRepo: '--repo=evil' } }))).toBeNull();
    expect(codePrRepoOf(code({ config: { prRepo: 'noslash' } }))).toBeNull();
    expect(codePrRepoOf(code({ config: {} }))).toBeNull();
  });
});

describe('PR-read pure helpers (Slice 2b)', () => {
  const listJson = JSON.stringify([
    { number: 7, title: 'Add Atlas launch flag', url: 'https://github.com/o/r/pull/7', state: 'OPEN', author: { login: 'a' } },
    { number: 8, title: 'Unrelated typo fix', url: 'https://github.com/o/r/pull/8', state: 'MERGED' },
  ]);
  it('parsePrList parses gh JSON + tolerates garbage', () => {
    expect(parsePrList(listJson)).toHaveLength(2);
    expect(parsePrList(listJson)[0]).toMatchObject({ number: 7, url: 'https://github.com/o/r/pull/7', title: 'Add Atlas launch flag' });
    expect(parsePrList('not json')).toEqual([]);
    expect(parsePrList('{"not":"array"}')).toEqual([]);
  });
  it('prMatchesTerm matches PR title case-insensitively', () => {
    const prs = parsePrList(listJson);
    expect(prMatchesTerm(prs[0], 'atlas')).toBe(true);
    expect(prMatchesTerm(prs[1], 'atlas')).toBe(false);
  });
  it('buildPrNote cites PR number + url, marks it a read-only gh scan', () => {
    const note = buildPrNote('o/r', 'Atlas', parsePrList(listJson).slice(0, 1));
    expect(note).toContain('#7');
    expect(note).toContain('https://github.com/o/r/pull/7');
    expect(note).toMatch(/read-only GitHub PR scan/i);
  });
});

describe('makeCodeResearchFn — PR reads via injected gh (Slice 2b; config-pinned, only through ghRead)', () => {
  const prList: GhReadFn = async () => ({ ok: true, stdout: JSON.stringify([{ number: 7, title: 'Add Atlas flag', url: 'https://github.com/o/r/pull/7', state: 'OPEN' }]) });
  it('lists the CONFIG-pinned prRepo → cited finding from real PR URLs', async () => {
    let calledRepo = '';
    const gh: GhReadFn = async (repo, op) => {
      calledRepo = repo;
      return prList(repo, op);
    };
    const fn = makeCodeResearchFn('/vault', { ghRead: gh });
    const res = await fn(code({ config: { prRepo: 'octocat/hello-world' } }), req('Atlas'));
    expect(calledRepo).toBe('octocat/hello-world'); // repo from CONFIG, not the request term
    expect(res.found).toBe(true);
    expect(res.citations).toContain('https://github.com/o/r/pull/7');
    expect(res.note).toContain('#7');
  });
  it('no title match → no-finding; never fabricates', async () => {
    const fn = makeCodeResearchFn('/vault', { ghRead: prList });
    expect(await fn(code({ config: { prRepo: 'o/r' } }), req('Nonexistent-Zzz'))).toMatchObject({ found: false, citations: [] });
  });
  it('gh-unavailable (BYOA) degrades gracefully to no-finding', async () => {
    const ghUnavail: GhReadFn = async () => ({ ok: false, reason: 'gh-unavailable', detail: 'gh not installed' });
    const fn = makeCodeResearchFn('/vault', { ghRead: ghUnavail });
    expect(await fn(code({ config: { prRepo: 'o/r' } }), req('Atlas'))).toMatchObject({ found: false });
  });
  it('does no PR read for a non-local-only tier (defense-in-depth)', async () => {
    let called = false;
    const gh: GhReadFn = async (repo, op) => {
      called = true;
      return prList(repo, op);
    };
    await makeCodeResearchFn('/vault', { ghRead: gh })(code({ egressTier: 'public-web', config: { prRepo: 'o/r' } }), req('Atlas'));
    expect(called).toBe(false);
  });
});

describe('codeAzTargetOf + az PR pure helpers (Slice 2b Azure)', () => {
  it('codeAzTargetOf reads the CONFIG-pinned az target; rejects bad org/missing parts → null', () => {
    expect(codeAzTargetOf(code({ config: { azOrg: 'https://dev.azure.com/contoso', azProject: 'P', azRepo: 'r' } }))).toEqual({ org: 'https://dev.azure.com/contoso', project: 'P', repository: 'r' });
    expect(codeAzTargetOf(code({ config: { azOrg: 'https://evil.com/x', azProject: 'P', azRepo: 'r' } }))).toBeNull();
    expect(codeAzTargetOf(code({ config: { azOrg: 'https://dev.azure.com/contoso', azProject: 'P' } }))).toBeNull(); // no repo
    expect(codeAzTargetOf(code({ config: {} }))).toBeNull();
  });
  const listJson = JSON.stringify([
    { pullRequestId: 12, title: 'Atlas: add flag', status: 'active' },
    { pullRequestId: 13, title: 'Unrelated', status: 'completed' },
  ]);
  it('parseAzPrList + azPrMatchesTerm + buildAzPrNote', () => {
    const prs = parseAzPrList(listJson);
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({ id: 12, title: 'Atlas: add flag' });
    expect(azPrMatchesTerm(prs[0], 'atlas')).toBe(true);
    expect(azPrMatchesTerm(prs[1], 'atlas')).toBe(false);
    expect(parseAzPrList('garbage')).toEqual([]);
    const note = buildAzPrNote({ org: 'https://dev.azure.com/contoso', project: 'P', repository: 'r' }, 'Atlas', prs.slice(0, 1));
    expect(note).toContain('!12');
    expect(note).toContain('https://dev.azure.com/contoso/P/_git/r/pullrequest/12'); // constructed URL
  });
});

describe('makeCodeResearchFn — Azure PR reads via injected az (Slice 2b; config-pinned, only through azRead)', () => {
  const azList: AzReadFn = async () => ({ ok: true, stdout: JSON.stringify([{ pullRequestId: 9, title: 'Atlas rollout', status: 'active' }]) });
  const azCfg = { azOrg: 'https://dev.azure.com/contoso', azProject: 'Proj', azRepo: 'repo' };
  it('lists the CONFIG-pinned az target → cited finding from constructed PR URLs', async () => {
    let calledOrg = '';
    const az: AzReadFn = async (target, op) => {
      calledOrg = target.org;
      return azList(target, op);
    };
    const res = await makeCodeResearchFn('/vault', { azRead: az })(code({ config: azCfg }), req('Atlas'));
    expect(calledOrg).toBe('https://dev.azure.com/contoso'); // target from CONFIG
    expect(res.found).toBe(true);
    expect(res.citations).toContain('https://dev.azure.com/contoso/Proj/_git/repo/pullrequest/9');
    expect(res.note).toContain('!9');
  });
  it('no title match → no-finding; az-unavailable → graceful no-finding', async () => {
    expect(await makeCodeResearchFn('/vault', { azRead: azList })(code({ config: azCfg }), req('Nope-Zzz'))).toMatchObject({ found: false });
    const azUnavail: AzReadFn = async () => ({ ok: false, reason: 'az-unavailable', detail: 'az not installed' });
    expect(await makeCodeResearchFn('/vault', { azRead: azUnavail })(code({ config: azCfg }), req('Atlas'))).toMatchObject({ found: false });
  });
  it('does no az read for a non-local-only tier (defense-in-depth)', async () => {
    let called = false;
    const az: AzReadFn = async (target, op) => {
      called = true;
      return azList(target, op);
    };
    await makeCodeResearchFn('/vault', { azRead: az })(code({ egressTier: 'public-web', config: azCfg }), req('Atlas'));
    expect(called).toBe(false);
  });
});

describe('makeCodeResearchFn — no clone attempted (graceful no-finding)', () => {
  it('returns no-finding without a repoPath, and for a non-local-only tier (defense-in-depth)', async () => {
    const fn = makeCodeResearchFn('/vault');
    expect(await fn(code({ config: {} }), req('Atlas'))).toMatchObject({ found: false, citations: [] });
    // mis-wired to public-web → must not run even if a repoPath is present
    expect(await fn(code({ egressTier: 'public-web', config: { repoPath: '/abs/repo' } }), req('Atlas'))).toMatchObject({ found: false });
  });
});

describe.skipIf(!gitAvailable)('makeCodeResearchFn — real local repo reads (RESEARCH-10/16)', () => {
  it('clones into the sandbox + greps the term → a cited finding from REAL files', async () => {
    const dir = await makeTempDir();
    try {
      const repo = await makeRepo(dir, { 'README.md': '# Project Atlas\nThe Atlas launch codename.\n', 'src/util.ts': 'export const x = 1;\n' });
      const vault = path.join(dir, 'vault');
      const fn = makeCodeResearchFn(vault);

      const res = await fn(code({ id: 'code-1', config: { repoPath: repo } }), req('Atlas'));
      expect(res.found).toBe(true);
      expect(res.citations).toContain('README.md'); // real repo-relative path
      expect(res.citations).not.toContain('src/util.ts'); // no false match
      expect(res.note).toContain('Atlas');
      expect(res.note).toMatch(/README\.md/);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a term absent from the repo is a no-finding (never fabricates)', async () => {
    const dir = await makeTempDir();
    try {
      const repo = await makeRepo(dir, { 'README.md': '# Hello\n' });
      const res = await makeCodeResearchFn(path.join(dir, 'vault'))(code({ config: { repoPath: repo } }), req('Nonexistent-Term-Zzz'));
      expect(res.found).toBe(false);
      expect(res.note).toBe('');
      expect(res.citations).toEqual([]);
    } finally {
      await rmTempDir(dir);
    }
  });
});

// ───────────────────────── RESEARCH-20: agentic Code researcher ─────────────────────────

describe('countAttributedCodeFacts — the RESEARCH-20/17 depth metric on the code path (mirrors #211)', () => {
  // A SUBSTANTIVE note: grouped findings, each attributed inline to a real `path:line`.
  const substantive = [
    '## Atlas — code findings',
    'The launch codename is defined in `README.md:1` as "Project Atlas".',
    '- `makeWebResearchFn` builds the production ResearchFn at src/kb/researchWebAgent.ts:250.',
    '- The egress gate `isAllowedUrl` rejects non-public hosts at src/kb/researchWebAgent.ts:190.',
    '- The per-pass budget is enforced in the fetch handler (src/kb/researchWebAgent.ts:314).',
    '- The default budget is 25 reads, set at src/kb/researchers.ts:54.',
  ].join('\n');
  // A THIN précis / grep dump (the defect): bare `path:line` lines with no prose, or prose with no cite.
  const grepDump = [
    'Found in 3 file(s):',
    'README.md:1',
    'src/util.ts:2',
    'src/index.ts:1',
    'This code is interesting and does several things of note across the repo.',
  ].join('\n');

  it('counts inline path:line-attributed facts in a substantive note', () => {
    expect(countAttributedCodeFacts(substantive)).toBe(5);
  });
  it('scores a grep dump / thin précis at ~0 (a bare path:line list is a defect, not a fact)', () => {
    expect(countAttributedCodeFacts(grepDump)).toBe(0);
  });
  it('separates substantive from thin — the ≥5 soft-floor a real agentic pass must clear (KB-QD bar)', () => {
    expect(countAttributedCodeFacts(substantive)).toBeGreaterThanOrEqual(5);
    expect(countAttributedCodeFacts(grepDump)).toBeLessThan(5);
  });
  it('does not count bare citations, prose without a path:line, or headings', () => {
    expect(countAttributedCodeFacts('')).toBe(0);
    expect(countAttributedCodeFacts('src/foo.ts:42')).toBe(0); // bare path:line, no prose
    expect(countAttributedCodeFacts('A general statement with no source location at all.')).toBe(0);
    expect(countAttributedCodeFacts('The handler validates input at src/foo.ts:42 before use.')).toBe(1);
  });
});

describe('filterCodeCitations — keep only REAL tracked files (path:line fabrication guard)', () => {
  const tracked = new Set(['README.md', 'src/util.ts', 'src/index.ts']);
  it('keeps citations whose path is a real tracked file (with the :line suffix), drops fabricated paths', () => {
    const cites = ['README.md:1', 'src/util.ts:2', 'src/НЕreal.ts:9', 'totally/made-up.ts:5', 'README.md:1'];
    expect(filterCodeCitations(cites, tracked)).toEqual(['README.md:1', 'src/util.ts:2']); // fabricated dropped, dedup
  });
  it('drops everything when nothing matches (no fabricated finding survives)', () => {
    expect(filterCodeCitations(['ghost.ts:1', 'phantom/x.ts'], tracked)).toEqual([]);
  });
});

describe('isIgnoredRepoPath + buildCandidateSet (RESEARCH-20 D-WS4-b read-layer guard)', () => {
  it('ignores vendored/generated/binary/lockfile paths, keeps real source', () => {
    for (const p of ['node_modules/x/index.js', '.git/config', 'dist/bundle.js', 'build/out.js', 'package-lock.json', 'yarn.lock', 'a/b.min.js', 'logo.png', 'app.wasm']) {
      expect(isIgnoredRepoPath(p), p).toBe(true);
    }
    for (const p of ['src/util.ts', 'README.md', 'lib/a.py']) expect(isIgnoredRepoPath(p), p).toBe(false);
  });
  it('orders grep-hit files by match count first, then directory neighbors; filters ignore-set; caps at MAX', () => {
    const grep = ['src/a.ts:1:x', 'src/a.ts:5:x', 'src/b.ts:2:x', 'node_modules/z.js:1:x'].join('\n');
    const tracked = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/readme.md', 'node_modules/z.js'];
    const cand = buildCandidateSet(grep, tracked);
    expect(cand[0]).toBe('src/a.ts'); // most hits first
    expect(cand[1]).toBe('src/b.ts'); // next hit
    expect(cand).toContain('src/c.ts'); // a neighbor in the hit directory
    expect(cand).not.toContain('docs/readme.md'); // not a neighbor of a hit dir
    expect(cand).not.toContain('node_modules/z.js'); // ignore-set, even though grep "hit" it
  });
  it('caps the candidate set at MAX_CANDIDATE_FILES', () => {
    const grep = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts:1:x`).join('\n');
    const tracked = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    expect(buildCandidateSet(grep, tracked).length).toBe(MAX_CANDIDATE_FILES);
  });
});

describe('CODE_RESEARCH_SKILL — untrusted-content + depth posture (RESEARCH-12/17/20)', () => {
  it('frames repo content as DATA, scopes to the request, demands path:line depth, forbids fabrication', () => {
    expect(CODE_RESEARCH_SKILL).toMatch(/DATA, never instructions/i);
    expect(CODE_RESEARCH_SKILL).toMatch(/ONLY the requested topic/i);
    expect(CODE_RESEARCH_SKILL).toMatch(/path:line|path\/to/i); // path:line attribution
    expect(CODE_RESEARCH_SKILL).toMatch(/read-only/i);
    expect(CODE_RESEARCH_SKILL).toMatch(/defect/i); // depth bar
    expect(CODE_RESEARCH_SKILL).toMatch(/never invent|do NOT fabricate|not there/i);
    expect(CODE_RESEARCH_SKILL).toMatch(/submitFindings/);
  });
});

describe.skipIf(!gitAvailable)('makeCodeRepoReader — read-only tools enforce caps in the read layer (D-WS4-b)', () => {
  it('reads a tracked file, tracks readPaths, truncates beyond the byte cap, refuses ignored/unsafe paths', async () => {
    const dir = await makeTempDir();
    try {
      const big = 'x'.repeat(MAX_FILE_READ_BYTES + 5000);
      const repo = await makeRepo(dir, { 'README.md': '# Hi\nsecond line\n', 'big.txt': big, 'node_modules/dep.js': 'evil()\n' });
      const ws = researcherWorkspace(path.join(dir, 'vault'), 'code-1');
      const { cloneOrRefresh } = await import('./codeGit');
      await cloneOrRefresh(ws, repo);
      const reader = makeCodeRepoReader(ws);

      const ok = await reader.readFile('README.md');
      expect('text' in ok && ok.text).toMatch(/second line/);
      expect(reader.readPaths.has('README.md')).toBe(true);

      const trunc = await reader.readFile('big.txt');
      expect('truncated' in trunc && trunc.truncated).toBe(true);
      expect('text' in trunc && trunc.text.length).toBeLessThanOrEqual(MAX_FILE_READ_BYTES + 64); // cap + marker

      expect(await reader.readFile('node_modules/dep.js')).toMatchObject({ error: expect.any(String) }); // ignore-set
      expect(await reader.readFile('../../etc/passwd')).toMatchObject({ error: expect.any(String) }); // path traversal refused
      expect(reader.readPaths.has('node_modules/dep.js')).toBe(false);

      const files = await reader.listFiles();
      expect(files).toContain('README.md');
      expect(files).not.toContain('node_modules/dep.js'); // ignore-set filtered out of the listing
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('makeCodeResearchFn — agentic local-repo pass (RESEARCH-20, injected session)', () => {
  // A fake agent that USES the read tools (so the read-only layer is exercised) and returns a substantive,
  // path:line-attributed note citing REAL files — the shape a real Copilot session must produce.
  const substantiveAgent: CodeSdkSession = async ({ read, candidates }) => {
    await read.listFiles();
    if (candidates[0]) await read.readFile(candidates[0]);
    const note = [
      '## Atlas — code findings',
      'The launch codename string lives in `README.md:1` ("Project Atlas").',
      '- The overview continues at README.md:2 describing the rollout plan.',
      '- A helper constant is exported at src/util.ts:1 (`export const x = 1`).',
      '- That constant is consumed by the build flag at src/util.ts:2.',
      '- The module is re-exported for consumers at src/index.ts:1.',
    ].join('\n');
    return { note, citations: ['README.md:1', 'README.md:2', 'src/util.ts:1', 'src/util.ts:2', 'src/index.ts:1', 'fabricated/ghost.ts:9'] };
  };

  async function withRepo<T>(fn: (repo: string, vault: string) => Promise<T>): Promise<T> {
    const dir = await makeTempDir();
    try {
      const repo = await makeRepo(dir, { 'README.md': '# Project Atlas\nThe Atlas launch codename and rollout.\n', 'src/util.ts': 'export const x = 1;\nexport const flag = true;\n', 'src/index.ts': "export { x } from './util';\n" });
      return await fn(repo, path.join(dir, 'vault'));
    } finally {
      await rmTempDir(dir);
    }
  }

  it('REGRESSION (substantive-output class): the agentic pass clears the countAttributedCodeFacts ≥5 soft-floor; the grep fallback does NOT', async () => {
    await withRepo(async (repo, vault) => {
      const agentic = await makeCodeResearchFn(vault, { session: substantiveAgent })(code({ config: { repoPath: repo } }), req('Atlas'));
      expect(agentic.found).toBe(true);
      expect(countAttributedCodeFacts(agentic.note)).toBeGreaterThanOrEqual(5); // depth bar met by the agentic note
      // The deterministic grep fallback (no session) is a dump — it does NOT clear the depth bar (the defect #7).
      const grep = await makeCodeResearchFn(vault, {})(code({ config: { repoPath: repo } }), req('Atlas'));
      expect(grep.found).toBe(true);
      expect(countAttributedCodeFacts(grep.note)).toBeLessThan(5);
    });
  });

  it('citations are validated to REAL repo files — the agent\'s fabricated path is dropped', async () => {
    await withRepo(async (repo, vault) => {
      const res = await makeCodeResearchFn(vault, { session: substantiveAgent })(code({ config: { repoPath: repo } }), req('Atlas'));
      expect(res.citations).toContain('README.md:1');
      expect(res.citations).toContain('src/util.ts:1');
      expect(res.citations.some((c) => c.includes('fabricated/ghost.ts'))).toBe(false); // fabrication guard
    });
  });

  it('RESEARCH-14: a FAILED agentic session degrades to the deterministic grep note (not a hard fail)', async () => {
    await withRepo(async (repo, vault) => {
      const throwing: CodeSdkSession = async () => {
        throw new Error('spawn copilot ENOENT'); // mirrors SDK-unavailable
      };
      const res = await makeCodeResearchFn(vault, { session: throwing })(code({ config: { repoPath: repo } }), req('Atlas'));
      expect(res.found).toBe(true); // fell back to grep, didn't fail
      expect(res.failed).toBeUndefined();
      expect(res.note).toMatch(/Code research:/); // the grep-fallback note shape
      expect(res.citations).toContain('README.md');
    });
  });

  it('READ-ONLY INVARIANT GUARD (RESEARCH-10): the agentic pass NEVER mutates the source repo + clones into the isolated gitignored sandbox', async () => {
    await withRepo(async (repo, vault) => {
      const headBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const statusBefore = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });

      // An agent that tries to read widely (the read tools are the ONLY surface — no write tool exists).
      const reader: CodeSdkSession = async ({ read }) => {
        await read.listFiles();
        await read.grep('Atlas');
        await read.readFile('README.md');
        await read.gitLog();
        return { note: 'Read README.md:1 for the codename.', citations: ['README.md:1'] };
      };
      await makeCodeResearchFn(vault, { session: reader })(code({ id: 'code-1', config: { repoPath: repo } }), req('Atlas'));

      // Source repo is byte-for-byte unchanged — no commit, no working-tree mutation.
      expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(headBefore);
      expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe(statusBefore);
      // The clone is the isolated, gitignored cache workspace — NOT the user's repo path.
      const ws = researcherWorkspace(vault, 'code-1');
      expect(ws).toContain(path.join('.kb', 'cache', 'researchers', 'code-1'));
      expect(ws.startsWith(path.resolve(repo))).toBe(false);
      // The reader exposes ONLY read methods — there is no write/commit/push affordance by construction.
      const r = makeCodeRepoReader(ws);
      expect(Object.keys(r).filter((k) => /write|commit|push|delete|mutat/i.test(k))).toEqual([]);
    });
  });
});
