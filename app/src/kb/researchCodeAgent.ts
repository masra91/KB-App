// The Code researcher's cognition (SPEC-0028 RESEARCH-10/16, Slice 2a pt2). A `ResearchFn` behind the
// SAME seam as Web (researchRun.ResearchFn): it brings the configured LOCAL repo current in the
// isolated sandbox and READS it to answer the request, returning a findings-note whose citations are
// REAL repo artifacts (repo-relative file paths). Two invariants from KB-QD's part-2 gate:
//   - it reaches git ONLY through `codeGit` (the RESEARCH-10 read-only layer) — there is no other
//     exec/process path here; write verbs are unreachable by construction.
//   - it NEVER fabricates: a no-match (or any error) is a graceful no-finding, never synthetic text.
// Findings re-enter the pipeline marked externally-sourced (runResearcher sets origin:secondary +
// externallySourced). Slice 2a is local-only; 2b adds gh/az remote PR reads behind the same seam.
import { buildOutboundQuery, type ResearchFn, type ResearchFindings } from './researchRun';
import { researcherWorkspace, cloneOrRefresh, gitRead, type CodeGitOptions } from './codeGit';
import { ghRead as ghReadImpl, isSafeGhRepo, type GhReadOp, type GhReadResult, type GhReadOptions } from './ghRead';
import type { ResearcherConfig, ResearchRequest } from './researchers';

/** The gh read seam — the real executor in prod; injected (fake) in unit tests (the live gh path is
 *  BYOA/network, validated in a gh-authed env, not units). */
export type GhReadFn = (repo: string, op: GhReadOp, opts?: GhReadOptions) => Promise<GhReadResult>;

export interface CodeResearchOptions {
  /** Passed through to the read-only git layer (clone/fetch depth, timeout, maxBuffer). */
  git?: CodeGitOptions;
  /** Passed through to the read-only gh layer (timeout, maxBuffer). */
  gh?: GhReadOptions;
  /** Inject the gh executor (tests); defaults to the real `ghRead`. */
  ghRead?: GhReadFn;
  /** Max file/PR citations on a finding (default 10). */
  maxCitations?: number;
  /** Max grep match lines to quote in the note (default 25). */
  maxMatchLines?: number;
}

/** The configured local repo for a `code` researcher (`config.repoPath`), or null. The path is fully
 *  validated (absolute + existing git repo) by codeGit.assertLocalRepoSource at run time. */
export function codeRepoSourceOf(r: ResearcherConfig): string | null {
  const v = r.config?.repoPath;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** The configured GitHub PR repo for a `code` researcher (`config.prRepo`, `owner/name`), or null —
 *  CONFIG-pinned (never an LLM-supplied repo; KB-QD 2b gate). Validated by `isSafeGhRepo`, so a
 *  malformed/flag-like value is dropped (the researcher just does no PR reads). */
export function codePrRepoOf(r: ResearcherConfig): string | null {
  const v = r.config?.prRepo;
  return typeof v === 'string' && isSafeGhRepo(v.trim()) ? v.trim() : null;
}

/** One PR summary from `gh pr list --json` output. */
interface PrSummary {
  number: number;
  title: string;
  url: string;
  state?: string;
  author?: string;
}

/** Parse `gh pr list --json …` stdout (a JSON array) into typed summaries, tolerating shape drift. */
export function parsePrList(stdout: string): PrSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PrSummary[] = [];
  for (const p of raw) {
    if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      if (typeof o.number === 'number' && typeof o.url === 'string') {
        out.push({
          number: o.number,
          url: o.url,
          title: typeof o.title === 'string' ? o.title : '',
          state: typeof o.state === 'string' ? o.state : undefined,
          author: o.author && typeof o.author === 'object' ? String((o.author as { login?: unknown }).login ?? '') : undefined,
        });
      }
    }
  }
  return out;
}

/** Does a PR's title mention the (lowercased) term? Title-only keeps the match egress-bounded + cheap;
 *  the request term is the only thing matched against (D6a — request-only). */
export function prMatchesTerm(pr: PrSummary, term: string): boolean {
  return pr.title.toLowerCase().includes(term.toLowerCase());
}

/** Build the PR findings-note from REAL gh data (titles + numbers). Nothing synthetic. */
export function buildPrNote(repo: string, term: string, prs: readonly PrSummary[]): string {
  return [
    `# Code research (PRs): ${term}`,
    '',
    `_Read-only GitHub PR scan of \`${repo}\` for "${term}" (BYOA gh)._`,
    '',
    `Matching PR(s):`,
    ...prs.map((p) => `- #${p.number} ${p.title}${p.state ? ` (${p.state})` : ''} — ${p.url}`),
  ].join('\n');
}

function dedupe(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (x && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** Build the markdown findings-note from REAL read output (grep matches + recent commits). All content
 *  is verbatim repo data — nothing synthetic. */
function buildNote(label: string, term: string, matchLines: readonly string[], files: readonly string[], log: string, maxMatchLines: number): string {
  const lines = [
    `# Code research: ${term}`,
    '',
    `_Local repository read by researcher "${label}" (read-only). Searched for "${term}"._`,
    '',
    `Found in ${files.length} file(s):`,
    ...files.map((f) => `- \`${f}\``),
    '',
    'Matches:',
    '```',
    ...matchLines.slice(0, maxMatchLines),
    '```',
  ];
  const recent = log.trim();
  if (recent) {
    lines.push('', 'Recent commits:', '```', recent, '```');
  }
  return lines.join('\n');
}

interface FindingPart {
  note: string;
  citations: string[];
}

/** Local-repo read pass (Slice 2a): clone/refresh + grep + recent log, ALL through codeGit. Returns a
 *  finding part, or null on no-match / read error. */
async function localReadPart(root: string, r: ResearcherConfig, repoSource: string, term: string, opts: CodeResearchOptions, maxCitations: number, maxMatchLines: number): Promise<FindingPart | null> {
  try {
    const ws = researcherWorkspace(root, r.id);
    await cloneOrRefresh(ws, repoSource, opts.git);
    const grep = await gitRead(ws, { kind: 'grep', pattern: term }, opts.git); // gitRead throws on unsafe term
    const matchLines = grep.split('\n').filter((l) => l.trim().length > 0);
    if (matchLines.length === 0) return null;
    const files = dedupe(matchLines.map((l) => l.split(':')[0])).slice(0, maxCitations);
    let log = '';
    try {
      log = await gitRead(ws, { kind: 'log', maxCount: 5 }, opts.git);
    } catch {
      log = '';
    }
    return { note: buildNote(r.label ?? r.template, term, matchLines, files, log, maxMatchLines), citations: files };
  } catch {
    return null;
  }
}

/** Remote PR read pass (Slice 2b): list PRs on the CONFIG-pinned repo via the gh layer, keep those
 *  whose title matches the request term, cite their URLs. gh-unavailable (BYOA) or no match → null
 *  (graceful — the researcher just contributes nothing from PRs), never a throw into the dispatch. */
async function prReadPart(prRepo: string, term: string, opts: CodeResearchOptions, maxCitations: number): Promise<FindingPart | null> {
  const gh = opts.ghRead ?? ghReadImpl;
  try {
    const res = await gh(prRepo, { kind: 'prList', state: 'all', limit: 30 }, opts.gh);
    if (!res.ok) return null; // gh-unavailable → skip PR reads gracefully (BYOA)
    const matched = parsePrList(res.stdout)
      .filter((p) => prMatchesTerm(p, term))
      .slice(0, maxCitations);
    if (matched.length === 0) return null;
    return { note: buildPrNote(prRepo, term, matched), citations: matched.map((p) => p.url) };
  } catch {
    return null;
  }
}

/**
 * Build the Code `ResearchFn` (RESEARCH-16). Asserts `local-only` (defense-in-depth). Combines up to
 * two read sources — both gated to CONFIG-pinned targets, reached ONLY through the read-only layers:
 *   - local repo (`config.repoPath`) → grep + log via codeGit (Slice 2a);
 *   - GitHub PRs (`config.prRepo`) → pr list via ghRead (Slice 2b; BYOA, graceful-degrade).
 * Citations are REAL repo files / PR URLs. Missing config / no match / read error → graceful
 * no-finding; it NEVER fabricates. Findings re-enter marked externally-sourced via runResearcher.
 */
export function makeCodeResearchFn(root: string, opts: CodeResearchOptions = {}): ResearchFn {
  const maxCitations = opts.maxCitations ?? 10;
  const maxMatchLines = opts.maxMatchLines ?? 25;
  return async (r: ResearcherConfig, req: ResearchRequest): Promise<ResearchFindings> => {
    const query = buildOutboundQuery(req);
    if (r.egressTier !== 'local-only') return { found: false, note: '', citations: [], query };
    const term = req.what.trim();
    const parts: FindingPart[] = [];

    const repoSource = codeRepoSourceOf(r);
    if (repoSource) {
      const local = await localReadPart(root, r, repoSource, term, opts, maxCitations, maxMatchLines);
      if (local) parts.push(local);
    }
    const prRepo = codePrRepoOf(r);
    if (prRepo) {
      const pr = await prReadPart(prRepo, term, opts, maxCitations);
      if (pr) parts.push(pr);
    }

    if (parts.length === 0) return { found: false, note: '', citations: [], query };
    return {
      found: true,
      note: parts.map((p) => p.note).join('\n\n---\n\n'),
      citations: dedupe(parts.flatMap((p) => p.citations)).slice(0, maxCitations * 2),
      query,
    };
  };
}
