// Self-nomination (SPEC-0028 RESEARCH-4, D3) — the cheap relevance check the dispatcher runs per
// eligible researcher before paying for a full research pass. Two-tier, matching the SDK-adopter
// pattern (ORCH-21/22): a thin CLI relevance call (one-shot `copilot -p`, like reflect/archivist)
// REFINES a deterministic heuristic; the heuristic is also the fallback when no runtime is wired or
// the call fails (fail-closed-to-heuristic — never blocks on the network, never over-fans).
//
// Egress note: the nomination prompt is built from the request's `what`/`why`/`context` + the
// researcher's own prompt/topics ONLY — never KB content (consistent with the D6a egress floor).
import { normalizeTerm, type ResearcherConfig, type ResearchRequest } from './researchers';

/** A one-shot text runtime (e.g. `copilot -p`); returns the model's raw reply. Injected for tests. */
export type NominateRunner = (prompt: string) => Promise<string>;

/**
 * Deterministic relevance heuristic (the fallback, ORCH-22): nominate when the request's text
 * overlaps the researcher's declared `topics`; a researcher with NO topics nominates (it has already
 * passed the dispatcher's eligibility pre-filter, so it's a general researcher for its tier). Pure.
 */
export function heuristicNominate(r: ResearcherConfig, req: ResearchRequest): boolean {
  if (!r.topics || r.topics.length === 0) return true;
  const hay = `${normalizeTerm(req.what)} ${normalizeTerm(req.context)}`;
  return r.topics.some((t) => hay.includes(normalizeTerm(t)));
}

/** Build the cheap relevance prompt (request + researcher framing only — no KB content). */
export function nominatePrompt(r: ResearcherConfig, req: ResearchRequest): string {
  return [
    `A researcher decides whether a research request is worth its time. Researcher purpose: ${r.prompt}`,
    r.topics && r.topics.length ? `Researcher topics: ${r.topics.join(', ')}.` : 'Researcher topics: (general).',
    `Request — what: ${req.what}; why: ${req.why}; context: ${req.context}`,
    'Is this researcher likely to find something genuinely relevant on its sources? Answer with a single word: YES or NO.',
  ].join('\n');
}

/** Parse a yes/no reply; null if neither is clearly present (caller falls back to the heuristic). */
export function parseYesNo(reply: string): boolean | null {
  const t = reply.trim().toLowerCase();
  if (/\byes\b/.test(t) && !/\bno\b/.test(t)) return true;
  if (/\bno\b/.test(t) && !/\byes\b/.test(t)) return false;
  return null;
}

/**
 * Build the dispatcher's `selfNominate` function. With no `runner` (tests / no runtime), it's the
 * deterministic heuristic. With a runner, it asks the cheap CLI and refines the heuristic — but an
 * unparseable reply OR a thrown call falls back to the heuristic (never blocks/over-fans on the
 * network). The dispatcher memoizes per (researcher, request), so this is paid at most once each.
 */
export function makeCliSelfNominate(runner?: NominateRunner): (r: ResearcherConfig, req: ResearchRequest) => Promise<boolean> {
  return async (r, req) => {
    if (!runner) return heuristicNominate(r, req);
    try {
      const parsed = parseYesNo(await runner(nominatePrompt(r, req)));
      return parsed ?? heuristicNominate(r, req);
    } catch {
      return heuristicNominate(r, req);
    }
  };
}
