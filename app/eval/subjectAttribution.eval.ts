// OPT-IN behavioural eval for Claims SUBJECT-ATTRIBUTION (SPEC-0047 2b). Runs the REAL Claims decider over
// the shared fixture for BOTH the subject (Mason, the first-person narrator) and the co-mention (Ngan,
// named in passing), and asserts the subject's career claims NEVER leak onto the co-mention's entity —
// the live misattribution bug DEV-2's prompt fix (#365) targets. This is the anti-regression measure.
//
// Double-gated like the other evals (lives under eval/, self-skips unless KB_EVAL=1) because it drives the
// REAL copilot decider (EVAL-2, no mocks) and is non-deterministic. The deterministic CI gate is the pure
// metric (src/kb/subjectAttributionEval.test.ts); THIS file is the on-demand behaviour probe.
//
//   Run:  cd app && KB_EVAL=1 npm run eval -- subjectAttribution
//
// It drives the SAME scenario as 2a's prompt-faithful test (claimsAgent.test.ts), imported from the shared
// fixture, so the fix and its eval can't drift.
import { describe, it, expect } from 'vitest';
import { makeClaimsDecider, type EntityInput } from '../src/kb/claimsAgent';
import {
  scoreAttribution,
  aggregateAttribution,
  formatAttributionAggregate,
  type AttributionScore,
} from '../src/kb/subjectAttributionEval';
import {
  ODSP_SOURCE_ID,
  ODSP_SOURCE_TEXT,
  MASON_ENTITY,
  NGAN_ENTITY,
  MASON_CAREER_CLAIMS,
} from '../src/kb/claimsSubjectAttribution.fixture';

const ENABLED = process.env.KB_EVAL === '1';
const RUNS = Number(process.env.KB_EVAL_RUNS ?? '3'); // N≥3 for robustness to non-determinism (KB-QD bar)
const RECALL_FLOOR = Number(process.env.KB_EVAL_RECALL_FLOOR ?? '0.5'); // soft: subject must keep his own claims
const TIMEOUT_MS = 12 * 60_000; // RUNS × 2 entities × a real copilot session (slow)

/** The subject's career statements — the must-NOT-leak set. */
const LEAK_CLAIMS = MASON_CAREER_CLAIMS.map((c) => c.statement);

/** Build the Claims work item: one entity node + the WHOLE shared source it derives from. */
function entityInput(entity: { entityId: string; kind: string; name: string }): EntityInput {
  return {
    entityId: entity.entityId,
    kind: entity.kind,
    name: entity.name,
    source: { sourceId: ODSP_SOURCE_ID, kind: 'text', text: ODSP_SOURCE_TEXT },
  };
}

describe.skipIf(!ENABLED)('SPEC-0047 2b — Claims subject-attribution (opt-in; real copilot)', () => {
  const decide = makeClaimsDecider(); // production decider — shells to `copilot -p`

  it(
    `the co-mention (${NGAN_ENTITY.name}) never inherits the subject (${MASON_ENTITY.name})'s career claims (≥${RUNS} runs)`,
    async () => {
      const scores: AttributionScore[] = [];
      for (let i = 0; i < RUNS; i++) {
        const coMention = await decide(entityInput(NGAN_ENTITY)); // run for the co-mentioned person …
        const subject = await decide(entityInput(MASON_ENTITY)); // … and for the actual subject
        scores.push(
          scoreAttribution({
            leakClaims: LEAK_CLAIMS,
            coMentionClaims: coMention.claims.map((c) => c.statement),
            subjectClaims: subject.claims.map((c) => c.statement),
          }),
        );
      }
      const agg = aggregateAttribution(`ODSP: ${MASON_ENTITY.name}→${NGAN_ENTITY.name}`, scores);
      console.log('\n' + formatAttributionAggregate(agg) + '\n');

      // HARD GUARD (every run): no subject career claim lands on the co-mention's entity — the cardinal
      // misattribution that silently corrupts an innocent person's page.
      expect(agg.everLeaked, `LEAK: ${NGAN_ENTITY.name} inherited ${MASON_ENTITY.name}'s claims`).toEqual([]);
      // SOFT floor: the subject still keeps his own career claims (a do-nothing decider leaks nothing but
      // is useless — this catches over-correction that drops everything).
      expect(agg.medianSubjectRecall, `RECALL: subject lost his own claims (below ${RECALL_FLOOR})`).toBeGreaterThanOrEqual(RECALL_FLOOR);
    },
    TIMEOUT_MS,
  );
});
