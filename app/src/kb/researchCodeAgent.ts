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
import type { ResearcherConfig, ResearchRequest } from './researchers';

export interface CodeResearchOptions {
  /** Passed through to the read-only git layer (clone/fetch depth, timeout, maxBuffer). */
  git?: CodeGitOptions;
  /** Max file citations on a finding (default 10) — a researcher cites the relevant files, not all. */
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

/**
 * Build the Code `ResearchFn` (RESEARCH-16). Asserts `local-only` (defense-in-depth — never runs for
 * another tier even if mis-wired). Resolves the configured repo, brings the isolated sandbox clone
 * current, greps the request term + reads recent commits — ALL through codeGit — and returns a cited
 * finding from the real matches. Any missing config / unsafe term / read error → graceful no-finding.
 */
export function makeCodeResearchFn(root: string, opts: CodeResearchOptions = {}): ResearchFn {
  const maxCitations = opts.maxCitations ?? 10;
  const maxMatchLines = opts.maxMatchLines ?? 25;
  return async (r: ResearcherConfig, req: ResearchRequest): Promise<ResearchFindings> => {
    const query = buildOutboundQuery(req);
    if (r.egressTier !== 'local-only') return { found: false, note: '', citations: [], query };
    const repoSource = codeRepoSourceOf(r);
    if (!repoSource) return { found: false, note: '', citations: [], query };
    const term = req.what.trim();
    try {
      const ws = researcherWorkspace(root, r.id);
      await cloneOrRefresh(ws, repoSource, opts.git);
      // READ-ONLY, only through codeGit: grep the request term (gitRead throws on an unsafe term →
      // caught → no-finding), then a little recent-commit context.
      const grep = await gitRead(ws, { kind: 'grep', pattern: term }, opts.git);
      const matchLines = grep.split('\n').filter((l) => l.trim().length > 0);
      if (matchLines.length === 0) return { found: false, note: '', citations: [], query };
      const files = dedupe(matchLines.map((l) => l.split(':')[0])).slice(0, maxCitations);
      let log = '';
      try {
        log = await gitRead(ws, { kind: 'log', maxCount: 5 }, opts.git);
      } catch {
        log = ''; // log is best-effort context; its absence never fails the finding
      }
      return { found: true, note: buildNote(r.label ?? r.template, term, matchLines, files, log, maxMatchLines), citations: files, query };
    } catch {
      return { found: false, note: '', citations: [], query };
    }
  };
}
