// Shared fixture for the Claims SUBJECT-ATTRIBUTION class (KB-Lead 04:55 #2; Principal dogfood).
//
// The live bug: a source narrating Mason's FIRST-PERSON career ("ODSP Work Experience") co-mentioned
// Ngan (his partner, also at Microsoft). The Claims decider, run for entity=Ngan over that source,
// attached Mason's WHOLE career to Ngan's entity page — a co-mentioned person inheriting the narrator's
// claims. Both 2a (prompt-fix, DEV-2 — claimsAgent.test.ts) and 2b (subject-attribution eval, DEV-1 —
// SPEC-0047) drive off THIS one scenario, imported from here, so the fix and its eval can't drift.

export const ODSP_SOURCE_ID = '01JODSPWORKEXP00000000000';

/** First-person career narration (Mason, the source's author/protagonist), with a colleague (Ngan)
 *  co-mentioned in passing — same employer, named relationally, NOTHING asserted about her own work. */
export const ODSP_SOURCE_TEXT = [
  'ODSP Work Experience',
  '',
  'I joined Microsoft in 2019 as a Program Manager on the Cloud team. Over the next four years I led',
  "the migration of three internal services to Azure and shipped the team's first telemetry pipeline.",
  'In 2022 I was promoted to Senior PM and took ownership of the on-call rotation.',
  '',
  'My partner Ngan also works at Microsoft, so we sometimes share the commute downtown. Outside work',
  'I volunteer at the local food bank on weekends.',
].join('\n');

/** The actual subject of the source — the first-person narrator. His career claims belong to HIM. */
export const MASON_ENTITY = { entityId: '01JMASON0000000000000000', kind: 'person', name: 'Mason' };

/** Co-mentioned only (shares an employer, named in passing). The source asserts nothing about HER
 *  work/history, so a correctly-attributed Claims pass over this source yields HER no career claims. */
export const NGAN_ENTITY = { entityId: '01JNGAN00000000000000000', kind: 'person', name: 'Ngan' };

/** Statements a model extracts from the first-person narration — they belong to Mason (the subject),
 *  and must NEVER appear on Ngan's entity (the misattribution class). Used by the prompt-faithful test
 *  runner (2a) and available to the eval (2b) as the "must-not-leak-onto-the-co-mention" set. */
export const MASON_CAREER_CLAIMS = [
  { statement: 'Joined Microsoft in 2019 as a Program Manager on the Cloud team', status: 'fact', confidence: 0.9, mentions: ['I joined Microsoft in 2019 as a Program Manager on the Cloud team'] },
  { statement: 'Led the migration of three internal services to Azure', status: 'fact', confidence: 0.85, mentions: ['I led the migration of three internal services to Azure'] },
  { statement: 'Promoted to Senior PM in 2022', status: 'fact', confidence: 0.9, mentions: ['In 2022 I was promoted to Senior PM'] },
] as const;
