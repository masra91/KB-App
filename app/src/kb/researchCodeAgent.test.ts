// The Code researcher cognition (SPEC-0028 RESEARCH-10/16, Slice 2a pt2). Exercised against a REAL
// local temp repo (git required; skipped if absent) — the finding is real repo data, never synthetic.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { makeCodeResearchFn, codeRepoSourceOf, codePrRepoOf, parsePrList, prMatchesTerm, buildPrNote, type GhReadFn } from './researchCodeAgent';
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
