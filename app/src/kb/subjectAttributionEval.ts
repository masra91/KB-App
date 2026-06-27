// Pure scoring for Claims SUBJECT-ATTRIBUTION (SPEC-0047 2b; pairs with DEV-2's prompt fix in #365). The
// bug class: a source narrating ONE person's FIRST-PERSON career co-mentions a colleague (same employer);
// the Claims decider, run for entity=the co-mention over that source, attaches the narrator's WHOLE career
// to THEIR page — a co-mentioned person inheriting the narrator's claims. The prompt fix anchors claims to
// the grammatical subject; THIS metric makes the class MEASURABLE so it can't silently regress.
//
// The cardinal sin (like dedup's false-merge) is a LEAK: a claim that belongs to the subject appearing on
// the CO-MENTION's entity. It is guarded HARD (zero, every run). A secondary, soft signal is subject
// RECALL: the subject's own claims should still land on the subject (a decider that emits nothing leaks
// nothing but is useless).
//
// Pure: no copilot, no fs. The behavioural eval (eval/subjectAttribution.eval.ts) drives the REAL Claims
// decider over the shared fixture (claimsSubjectAttribution.fixture.ts) and feeds its statements here;
// this module is unit-tested deterministically (CI green).

// Function words that carry no attribution signal — dropped before matching so a rephrase ("I joined
// Northwind" vs "Joined Northwind in 2019") still matches on its CONTENT tokens, and short connective
// words don't manufacture spurious overlap.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'to', 'as', 'and', 'for', 'at', 'with', 'by', 'from', 'into',
  'was', 'were', 'is', 'are', 'be', 'been', 'has', 'had', 'have', 'i', 'my', 'me', 'he', 'she', 'they',
  'it', 'her', 'his', 'their', 'we', 'our', 'who', 'that', 'this', 'over', 'next', 'first', 'also',
]);

/** Normalize a statement to its lowercased CONTENT-token set (punctuation stripped, stopwords removed). */
export function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}

/** Fraction of the LEAK claim's content tokens present in a `produced` statement (directional: "does
 *  `produced` convey what the leak claim says?"). 0 when the leak has no content tokens. */
export function claimContainment(leak: string, produced: string): number {
  const l = contentTokens(leak);
  if (l.size === 0) return 0;
  const p = contentTokens(produced);
  let hit = 0;
  for (const t of l) if (p.has(t)) hit++;
  return hit / l.size;
}

/** Does `produced` assert (a rephrase of) the subject-only `leak` claim? Containment ≥ threshold so the
 *  model's paraphrase still matches without demanding exact wording. Default 0.6 = a clear majority of the
 *  leak's distinctive content, low enough to catch rephrases, high enough to avoid incidental overlap. */
export function claimMatches(produced: string, leak: string, threshold = 0.6): boolean {
  return claimContainment(leak, produced) >= threshold;
}

/** One scored attribution run: a Claims pass over the shared source for BOTH entities. */
export interface AttributionScore {
  /** Size of the must-not-leak set (the subject's distinctive claims). */
  leakClaims: number;
  /** Subject claims that LEAKED onto the co-mention (the cardinal sin → 0). */
  leakedOntoCoMention: number;
  /** Subject claims correctly attributed to the subject (recall numerator). */
  attributedToSubject: number;
  /** leakedOntoCoMention / leakClaims — the misattribution rate (→ 0). */
  leakRate: number;
  /** attributedToSubject / leakClaims — did the subject keep his own claims (→ 1)? */
  subjectRecall: number;
  /** The offending leaked statements, for human-readable reporting (show what leaked, not just a count). */
  leaks: string[];
}

/**
 * Score one attribution run. `leakClaims` are the subject-only statements that must NEVER appear on the
 * co-mention; `coMentionClaims` / `subjectClaims` are the statements the decider produced for each entity
 * over the SAME source. A leak claim is "leaked" if any co-mention claim matches it, "attributed" if any
 * subject claim matches it. Empty leak set → vacuously clean (leakRate 0, recall 1).
 */
export function scoreAttribution(args: {
  leakClaims: string[];
  coMentionClaims: string[];
  subjectClaims: string[];
  threshold?: number;
}): AttributionScore {
  const th = args.threshold ?? 0.6;
  const leaks: string[] = [];
  let attributedToSubject = 0;
  for (const leak of args.leakClaims) {
    if (args.coMentionClaims.some((c) => claimMatches(c, leak, th))) leaks.push(leak);
    if (args.subjectClaims.some((c) => claimMatches(c, leak, th))) attributedToSubject++;
  }
  const n = args.leakClaims.length;
  return {
    leakClaims: n,
    leakedOntoCoMention: leaks.length,
    attributedToSubject,
    leakRate: n === 0 ? 0 : leaks.length / n,
    subjectRecall: n === 0 ? 1 : attributedToSubject / n,
    leaks,
  };
}

export interface AttributionAggregate {
  name: string;
  runs: number;
  medianLeakRate: number;
  /** The WORST single run's leak rate (max) — non-determinism can't hide an occasional leak. */
  worstLeakRate: number;
  medianSubjectRecall: number;
  /** The worst single run's recall (min). */
  worstSubjectRecall: number;
  /** Union of every distinct statement that leaked in ANY run — the HARD guard asserts this is empty (a
   *  single run that misattributes a subject claim is a failure, like dedup's everFalseMerged). */
  everLeaked: string[];
  leakRates: number[];
  subjectRecalls: number[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Aggregate per-run scores: median + worst leak rate / recall (non-determinism tolerance) + the strict
 *  union of any leak across runs (the guard is "never, in any run"). */
export function aggregateAttribution(name: string, scores: AttributionScore[]): AttributionAggregate {
  const leakRates = scores.map((s) => s.leakRate);
  const subjectRecalls = scores.map((s) => s.subjectRecall);
  const seen = new Set<string>();
  const everLeaked: string[] = [];
  for (const s of scores) {
    for (const leak of s.leaks) {
      if (!seen.has(leak)) {
        seen.add(leak);
        everLeaked.push(leak);
      }
    }
  }
  return {
    name,
    runs: scores.length,
    medianLeakRate: median(leakRates),
    worstLeakRate: leakRates.length ? Math.max(...leakRates) : 0,
    medianSubjectRecall: median(subjectRecalls),
    worstSubjectRecall: subjectRecalls.length ? Math.min(...subjectRecalls) : 1,
    everLeaked,
    leakRates,
    subjectRecalls,
  };
}

/** Format an aggregate for the eval's console report (the eval's whole purpose is to REPORT behaviour). */
export function formatAttributionAggregate(agg: AttributionAggregate): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `── ${agg.name} (${agg.runs} run${agg.runs === 1 ? '' : 's'}) ──`,
    `  leak rate    median=${pct(agg.medianLeakRate)} worst=${pct(agg.worstLeakRate)} runs=[${agg.leakRates.map(pct).join(', ')}]`,
    `  subj recall  median=${pct(agg.medianSubjectRecall)} worst=${pct(agg.worstSubjectRecall)} runs=[${agg.subjectRecalls.map(pct).join(', ')}]`,
  ];
  if (agg.everLeaked.length) {
    lines.push(`  ⚠ MISATTRIBUTED onto the co-mention (guard FAIL):`);
    for (const s of agg.everLeaked) lines.push(`      ✗ "${s}"`);
  } else {
    lines.push(`  ✓ no subject claims leaked onto the co-mention in any run`);
  }
  return lines.join('\n');
}
