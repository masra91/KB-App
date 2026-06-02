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
import { azRead as azReadImpl, isSafeAzTarget, type AzReadOp, type AzReadResult, type AzReadOptions, type AzdoTarget } from './azRead';
import type { ResearcherConfig, ResearchRequest } from './researchers';

/** The gh read seam — the real executor in prod; injected (fake) in unit tests (the live gh path is
 *  BYOA/network, validated in a gh-authed env, not units). */
export type GhReadFn = (repo: string, op: GhReadOp, opts?: GhReadOptions) => Promise<GhReadResult>;

/** The az read seam — same shape: real executor in prod, injected (fake) in unit tests. */
export type AzReadFn = (target: AzdoTarget, op: AzReadOp, opts?: AzReadOptions) => Promise<AzReadResult>;

export interface CodeResearchOptions {
  /** Passed through to the read-only git layer (clone/fetch depth, timeout, maxBuffer). */
  git?: CodeGitOptions;
  /** Passed through to the read-only gh layer (timeout, maxBuffer). */
  gh?: GhReadOptions;
  /** Inject the gh executor (tests); defaults to the real `ghRead`. */
  ghRead?: GhReadFn;
  /** Passed through to the read-only az layer (timeout, maxBuffer). */
  az?: AzReadOptions;
  /** Inject the az executor (tests); defaults to the real `azRead`. */
  azRead?: AzReadFn;
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

/** The configured Azure DevOps PR target for a `code` researcher (`config.azOrg`/`azProject`/`azRepo`),
 *  or null — CONFIG-pinned (never LLM-supplied; KB-QD 2b gate). Validated by `isSafeAzTarget` (org-host
 *  allowlist + name guards), so a malformed value is dropped (the researcher just does no Azure reads). */
export function codeAzTargetOf(r: ResearcherConfig): AzdoTarget | null {
  const c = r.config;
  if (!c) return null;
  const candidate = { org: typeof c.azOrg === 'string' ? c.azOrg.trim() : '', project: typeof c.azProject === 'string' ? c.azProject.trim() : '', repository: typeof c.azRepo === 'string' ? c.azRepo.trim() : '' };
  return isSafeAzTarget(candidate) ? candidate : null;
}

/** One PR summary from `gh pr list --json` output. */
interface PrSummary {
  number: number;
  title: string;
  url: string;
  state?: string;
  author?: string;
}

/** One PR summary from `az repos pr list --output json`. Azure JSON has `pullRequestId`+`title`+
 *  `status`; the web URL is constructed from the target + id (see buildAzPrNote). */
interface AzPrSummary {
  id: number;
  title: string;
  status?: string;
}

/** Parse `az repos pr list --output json` stdout into typed summaries, tolerating shape drift. */
export function parseAzPrList(stdout: string): AzPrSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: AzPrSummary[] = [];
  for (const p of raw) {
    if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      if (typeof o.pullRequestId === 'number') {
        out.push({ id: o.pullRequestId, title: typeof o.title === 'string' ? o.title : '', status: typeof o.status === 'string' ? o.status : undefined });
      }
    }
  }
  return out;
}

/** Does an Azure PR's title mention the (lowercased) term? Title-only, request-only (D6a). */
export function azPrMatchesTerm(pr: AzPrSummary, term: string): boolean {
  return pr.title.toLowerCase().includes(term.toLowerCase());
}

/** The deterministic web URL for an Azure DevOps PR (the citation) — built from the CONFIG target +
 *  id, so the citation can't be agent-fabricated. `<org>/<project>/_git/<repo>/pullrequest/<id>`. */
function azPrUrl(target: AzdoTarget, id: number): string {
  return `${target.org.replace(/\/+$/, '')}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(target.repository)}/pullrequest/${id}`;
}

/** Build the Azure-PR findings-note from REAL az data (titles + ids), citing constructed PR URLs. */
export function buildAzPrNote(target: AzdoTarget, term: string, prs: readonly AzPrSummary[]): string {
  return [
    `# Code research (Azure DevOps PRs): ${term}`,
    '',
    `_Read-only Azure DevOps PR scan of \`${target.project}/${target.repository}\` for "${term}" (BYOA az)._`,
    '',
    `Matching PR(s):`,
    ...prs.map((p) => `- !${p.id} ${p.title}${p.status ? ` (${p.status})` : ''} — ${azPrUrl(target, p.id)}`),
  ].join('\n');
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

/** Remote Azure DevOps PR read pass (Slice 2b): list PRs on the CONFIG-pinned target via the az layer,
 *  keep title-matches, cite constructed PR URLs. az-unavailable (BYOA) / no match → null (graceful). */
async function azReadPart(target: AzdoTarget, term: string, opts: CodeResearchOptions, maxCitations: number): Promise<FindingPart | null> {
  const az = opts.azRead ?? azReadImpl;
  try {
    const res = await az(target, { kind: 'prList', status: 'all', top: 30 }, opts.az);
    if (!res.ok) return null; // az-unavailable → skip gracefully (BYOA)
    const matched = parseAzPrList(res.stdout)
      .filter((p) => azPrMatchesTerm(p, term))
      .slice(0, maxCitations);
    if (matched.length === 0) return null;
    return { note: buildAzPrNote(target, term, matched), citations: matched.map((p) => azPrUrl(target, p.id)) };
  } catch {
    return null;
  }
}

/**
 * Build the Code `ResearchFn` (RESEARCH-16). Asserts `local-only` (defense-in-depth). Combines up to
 * three read sources — ALL gated to CONFIG-pinned targets, reached ONLY through the read-only layers:
 *   - local repo (`config.repoPath`) → grep + log via codeGit (Slice 2a);
 *   - GitHub PRs (`config.prRepo`) → pr list via ghRead (Slice 2b; BYOA, graceful-degrade);
 *   - Azure DevOps PRs (`config.azOrg`/`azProject`/`azRepo`) → pr list via azRead (Slice 2b; BYOA).
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
    const azTarget = codeAzTargetOf(r);
    if (azTarget) {
      const az = await azReadPart(azTarget, term, opts, maxCitations);
      if (az) parts.push(az);
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
