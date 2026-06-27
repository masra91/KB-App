// Shared fixture for the Claims SUBJECT-ATTRIBUTION class (KB-Lead 04:55 #2). A fully FICTIONAL persona
// (no real personal data) that reproduces the bug SHAPE exactly — names, employer, and details are
// invented; only the grammatical structure (one first-person narrator + a co-mentioned colleague) matters.
//
// The bug class: a source narrating ONE person's FIRST-PERSON career ("Work History Note") co-mentions a
// colleague in passing (same employer, NOTHING asserted about their own work). The Claims decider, run
// for entity=the co-mention over that source, wrongly attaches the NARRATOR's whole career to the
// co-mention's entity page. Both 2a (prompt-fix, claimsAgent.test.ts) and 2b (subject-attribution eval,
// SPEC-0047) drive off THIS one scenario, imported from here, so the fix and its eval can't drift.

export const WORKHIST_SOURCE_ID = '01JWORKHIST00000000000000';

/** First-person career narration (the subject — the source's author/protagonist), with a colleague
 *  co-mentioned in passing — same employer, named relationally, NOTHING asserted about their own work. */
export const WORKHIST_SOURCE_TEXT = [
  'Work History Note',
  '',
  'I joined Northwind Traders in 2019 as a Logistics Coordinator on the Fulfillment team. Over the next',
  "four years I led the rollout of two regional sorting hubs and shipped the team's first returns dashboard.",
  'In 2022 I was promoted to Operations Lead and took ownership of the weekend dispatch rotation.',
  '',
  'My teammate Robin also works at Northwind Traders, so we sometimes carpool to the depot. Outside work',
  'I coach a youth robotics club on weekends.',
].join('\n');

/** The actual subject of the source — the first-person narrator. Their career claims belong to THEM. */
export const SUBJECT_ENTITY = { entityId: '01JSUBJECT000000000000000', kind: 'person', name: 'Devin' };

/** Co-mentioned only (shares an employer, named in passing). The source asserts nothing about THEIR
 *  work/history, so a correctly-attributed Claims pass over this source yields THEM no career claims. */
export const COMENTION_ENTITY = { entityId: '01JCOMENTION0000000000000', kind: 'person', name: 'Robin' };

/** Statements a model extracts from the first-person narration — they belong to the SUBJECT, and must
 *  NEVER appear on the CO-MENTION's entity (the misattribution class). Used by the prompt-faithful test
 *  runner (2a) and available to the eval (2b) as the "must-not-leak-onto-the-co-mention" set. */
export const SUBJECT_CAREER_CLAIMS = [
  { statement: 'Joined Northwind Traders in 2019 as a Logistics Coordinator on the Fulfillment team', status: 'fact', confidence: 0.9, mentions: ['I joined Northwind Traders in 2019 as a Logistics Coordinator on the Fulfillment team'] },
  { statement: 'Led the rollout of two regional sorting hubs', status: 'fact', confidence: 0.85, mentions: ['I led the rollout of two regional sorting hubs'] },
  { statement: 'Promoted to Operations Lead in 2022', status: 'fact', confidence: 0.9, mentions: ['In 2022 I was promoted to Operations Lead'] },
] as const;
