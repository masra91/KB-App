// Generalized, labeled fixtures for the EVAL-13 dedup / node-finding precision-recall eval (SPEC-0042).
// SHARED with the Reflect impl (REFLECT-14..18, DEV-3) — Connect measures within-block dedup, Reflect
// measures cross-block name-variant consolidation, both scored by the SAME metric (src/kb/dedupEval.ts).
//
// NO-SECRETS / public-safe (the #242/#244 cassette guardrail posture extended to fixtures): every name,
// source, mention and excerpt below is SYNTHETIC — no real person, no private vault data. Each item
// carries a ground-truth `entity` label: items sharing a label ARE the same real thing (should merge),
// differing labels are DISTINCT (must NOT be merged — the don't-false-merge guard).
//
// Two families because blocking gates what each system can even see:
//  - CONNECT works WITHIN a block (kind + normalized name), so its fixtures put SAME-blockKey candidates
//    together — the real false-merge risk (two distinct "Caroline"s) and the real dedup win (one
//    "Caroline Winters" across sources) both live inside a single block.
//  - REFLECT works ACROSS blocks (it ruminates over existing nodes), so its fixtures are name-VARIANT
//    nodes ("Caroline" / "Caroline Winters" / "Caroline Winters Azzone") that Connect's exact-name
//    blocking can never bring together — only Reflect can consolidate them (or wrongly merge a decoy).

// ── Connect: within-block dedup + node-finding ──────────────────────────────────────────────────────

export interface ConnectDedupCandidate {
  id: string;
  name: string;
  source: string; // sourceId (synthetic)
  mentions: string[]; // the evidence the agent reasons over
  entity: string; // GROUND TRUTH: the real thing this candidate is
}
export interface ConnectDedupExisting {
  id: string;
  name: string;
  entity: string; // GROUND TRUTH
}
export interface ConnectDedupFixture {
  name: string;
  probe: string; // what this fixture measures
  kind: string;
  candidates: ConnectDedupCandidate[];
  existingNodes?: ConnectDedupExisting[];
}

export const CONNECT_DEDUP_FIXTURES: ConnectDedupFixture[] = [
  {
    name: 'caroline-winters-duplicate-across-sources',
    probe: 'RECALL: the same "Caroline Winters" mentioned in three notes collapses to ONE entity.',
    kind: 'person',
    candidates: [
      { id: 'cw1', name: 'Caroline Winters', source: 's-standup', mentions: ['Caroline Winters ran the Tuesday standup'], entity: 'caroline-winters' },
      { id: 'cw2', name: 'Caroline Winters', source: 's-email', mentions: ['emailed Caroline Winters about the migration plan'], entity: 'caroline-winters' },
      { id: 'cw3', name: 'Caroline Winters', source: 's-review', mentions: ['Caroline Winters approved the design review'], entity: 'caroline-winters' },
    ],
  },
  {
    name: 'two-distinct-carolines-same-block',
    probe: 'PRECISION (the guard): two DIFFERENT people both surface as bare "Caroline" — never merge them.',
    kind: 'person',
    candidates: [
      // Distinguishable from context: one is a climbing partner, the other a supplier contact.
      { id: 'ca', name: 'Caroline', source: 's-gym', mentions: ['Caroline belayed me at the climbing gym on Saturday'], entity: 'caroline-climber' },
      { id: 'cb', name: 'Caroline', source: 's-invoice', mentions: ['Caroline from Azzone Supplies sent the Q2 invoice'], entity: 'caroline-azzone-contact' },
    ],
  },
  {
    name: 'jordan-mixed-merge-and-split',
    probe: 'BOTH: merge the two "Jordan" mentions that are one coworker; keep the unrelated "Jordan" distinct.',
    kind: 'person',
    candidates: [
      { id: 'j1', name: 'Jordan', source: 's-pr', mentions: ['Jordan reviewed the auth PR and shipped the fix'], entity: 'jordan-eng' },
      { id: 'j2', name: 'Jordan', source: 's-oncall', mentions: ['Jordan was on call and patched the auth regression'], entity: 'jordan-eng' },
      { id: 'j3', name: 'Jordan', source: 's-trip', mentions: ['met Jordan, my cousin, at the family reunion in Ohio'], entity: 'jordan-cousin' },
    ],
  },
  {
    name: 'node-finding-fold-into-existing',
    probe: 'NODE-FINDING: a new "Caroline Winters" candidate folds into the EXISTING Caroline Winters node.',
    kind: 'person',
    existingNodes: [{ id: 'node-cw', name: 'Caroline Winters', entity: 'caroline-winters' }],
    candidates: [
      { id: 'cwN', name: 'Caroline Winters', source: 's-new', mentions: ['Caroline Winters joined the platform team'], entity: 'caroline-winters' },
    ],
  },
];

// ── Reflect: cross-block name-variant consolidation ─────────────────────────────────────────────────

export interface ReflectDedupNode {
  rel: string; // repo-relative entity path (the node's id for scoring)
  name: string;
  kind: string;
  excerpt: string; // a short body snippet the agent ruminates over
  tags?: string[];
  entity: string; // GROUND TRUTH
}
export interface ReflectConsolidationFixture {
  name: string;
  probe: string;
  nodes: ReflectDedupNode[];
}

export const REFLECT_CONSOLIDATION_FIXTURES: ReflectConsolidationFixture[] = [
  {
    name: 'caroline-name-variants-consolidate',
    probe: 'RECALL + guard: consolidate the three "Caroline Winters Azzone" name-variants; LEAVE the distinct Caroline.',
    nodes: [
      // The SAME person under three name lengths — Connect's exact-name blocking never compares these.
      { rel: 'entities/person/caroline.md', name: 'Caroline', kind: 'person', entity: 'caroline-wa', excerpt: 'Platform engineer at Azzone; ran the Tuesday standup; led the migration.' },
      { rel: 'entities/person/caroline-winters.md', name: 'Caroline Winters', kind: 'person', entity: 'caroline-wa', excerpt: 'Engineer on the platform team at Azzone; approved the design review; ran the migration.' },
      { rel: 'entities/person/caroline-winters-azzone.md', name: 'Caroline Winters Azzone', kind: 'person', entity: 'caroline-wa', excerpt: 'Azzone platform engineer; full name on the offer letter; led the Tuesday standup.' },
      // A genuinely DIFFERENT Caroline — the decoy the consolidation must not swallow (the guard).
      { rel: 'entities/person/caroline-brooks.md', name: 'Caroline Brooks', kind: 'person', entity: 'caroline-brooks', excerpt: "Caroline Brooks is the children's-book author from Portland; unrelated to Azzone." },
    ],
  },
  {
    name: 'distinct-same-first-name-no-consolidate',
    probe: 'PRECISION (the guard): two different "Sam"s must NOT be consolidated, however similar the names look.',
    nodes: [
      { rel: 'entities/person/sam-rivera.md', name: 'Sam Rivera', kind: 'person', entity: 'sam-rivera', excerpt: 'Sam Rivera is the QA lead in the Dublin office; owns the release checklist.' },
      { rel: 'entities/person/sam-patel.md', name: 'Sam Patel', kind: 'person', entity: 'sam-patel', excerpt: 'Sam Patel is the finance analyst in Austin; owns the quarterly budget.' },
    ],
  },
];
