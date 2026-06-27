// Deterministic CI coverage for the SUBJECT-ATTRIBUTION metric (SPEC-0047 2b). The behavioural eval
// (eval/subjectAttribution.eval.ts) drives the REAL Claims decider and feeds its statements here; this
// guards the scoring logic the report hinges on — rephrase-tolerant matching, leak detection, the union
// guard — with no copilot.
import { describe, it, expect } from 'vitest';
import {
  contentTokens,
  claimContainment,
  claimMatches,
  scoreAttribution,
  aggregateAttribution,
  formatAttributionAggregate,
  type AttributionScore,
} from './subjectAttributionEval';
import { SUBJECT_CAREER_CLAIMS } from './claimsSubjectAttribution.fixture';

const LEAK = SUBJECT_CAREER_CLAIMS.map((c) => c.statement);

describe('contentTokens / claimContainment (rephrase-tolerant matching)', () => {
  it('drops stopwords + punctuation so a paraphrase still overlaps on content', () => {
    expect([...contentTokens('I joined Northwind in 2019!')].sort()).toEqual(['2019', 'joined', 'northwind']);
  });

  it('containment is directional — the leak claim\'s content tokens found in the produced statement', () => {
    // produced rephrase carries all of the leak's content words → containment 1
    expect(claimContainment('Promoted to Operations Lead in 2022', 'He was promoted to Operations Lead back in 2022')).toBe(1);
    // unrelated statement → ~0
    expect(claimContainment('Promoted to Operations Lead in 2022', 'Coaches a youth robotics club')).toBe(0);
  });
});

describe('claimMatches (threshold)', () => {
  it('matches a rephrase of a leak claim and rejects an unrelated one', () => {
    expect(claimMatches('She joined Northwind Traders in 2019 as a Logistics Coordinator on the Fulfillment team', LEAK[0])).toBe(true);
    expect(claimMatches('Works at Northwind', LEAK[0])).toBe(false); // shares only "northwind" — below 0.6
    expect(claimMatches('Coaches a youth robotics club on weekends', LEAK[0])).toBe(false);
  });
});

describe('scoreAttribution (one Claims pass over both entities)', () => {
  it('THE BUG: the subject\'s whole career leaked onto the co-mention → leakRate 1, every leak named', () => {
    const s = scoreAttribution({ leakClaims: LEAK, coMentionClaims: [...LEAK], subjectClaims: [...LEAK] });
    expect(s.leakedOntoCoMention).toBe(LEAK.length);
    expect(s.leakRate).toBe(1);
    expect(s.leaks).toEqual(LEAK);
    expect(s.subjectRecall).toBe(1); // claims are on the subject too — recall is fine; the LEAK is the defect
  });

  it('THE FIX: co-mention gets none of the career claims, subject keeps them → leakRate 0, recall 1', () => {
    const s = scoreAttribution({
      leakClaims: LEAK,
      coMentionClaims: ['Works at Northwind', "Is Devin's teammate"], // legitimately about Robin, not the subject's career
      subjectClaims: [...LEAK],
    });
    expect(s.leakedOntoCoMention).toBe(0);
    expect(s.leakRate).toBe(0);
    expect(s.subjectRecall).toBe(1);
    expect(s.leaks).toEqual([]);
  });

  it('partial leak: one career claim slips onto the co-mention', () => {
    const s = scoreAttribution({ leakClaims: LEAK, coMentionClaims: [LEAK[1]], subjectClaims: [...LEAK] });
    expect(s.leakedOntoCoMention).toBe(1);
    expect(s.leakRate).toBeCloseTo(1 / 3);
    expect(s.leaks).toEqual([LEAK[1]]);
  });

  it('a subject that emits nothing leaks nothing but tanks recall (the do-nothing decider)', () => {
    const s = scoreAttribution({ leakClaims: LEAK, coMentionClaims: [], subjectClaims: [] });
    expect(s.leakRate).toBe(0);
    expect(s.subjectRecall).toBe(0);
  });

  it('empty leak set is vacuously clean', () => {
    const s = scoreAttribution({ leakClaims: [], coMentionClaims: ['anything'], subjectClaims: [] });
    expect(s.leakRate).toBe(0);
    expect(s.subjectRecall).toBe(1);
  });
});

describe('aggregateAttribution (across runs — non-determinism)', () => {
  const clean: AttributionScore = { leakClaims: 3, leakedOntoCoMention: 0, attributedToSubject: 3, leakRate: 0, subjectRecall: 1, leaks: [] };
  const leaky: AttributionScore = { leakClaims: 3, leakedOntoCoMention: 1, attributedToSubject: 3, leakRate: 1 / 3, subjectRecall: 1, leaks: [LEAK[0]] };

  it('unions every leak across runs (the guard is "never, in any run") + reports worst rates', () => {
    const agg = aggregateAttribution('work-history', [clean, clean, leaky]);
    expect(agg.everLeaked).toEqual([LEAK[0]]); // one run leaked → flagged even though median is 0
    expect(agg.medianLeakRate).toBe(0);
    expect(agg.worstLeakRate).toBeCloseTo(1 / 3);
    expect(agg.worstSubjectRecall).toBe(1);
  });

  it('all clean → empty union (the PASS case) + formatter says so', () => {
    const agg = aggregateAttribution('work-history', [clean, clean]);
    expect(agg.everLeaked).toEqual([]);
    expect(formatAttributionAggregate(agg)).toContain('no subject claims leaked');
  });

  it('formatter names the offending statements on failure', () => {
    const agg = aggregateAttribution('work-history', [leaky]);
    expect(formatAttributionAggregate(agg)).toContain('MISATTRIBUTED');
    expect(formatAttributionAggregate(agg)).toContain(LEAK[0]);
  });
});
