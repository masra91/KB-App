---
spec: SPEC-0004
key: LIFE
title: KB Lifecycle & Capabilities
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0001, SPEC-0002, SPEC-0003]
supersedes: null
---

# KB Lifecycle & Capabilities

> The knowledge base exists to continuously transform raw information into
> **trusted, discoverable, and actionable** knowledge. This process is **cyclical,
> not linear**. These eight stages are the canonical capabilities feature specs slot
> under.

## 1. Intent (the why / JTBD)

SPEC-0003 tells the *story* of the core loop. This spec names the **stable
capabilities** that make the story real, so every feature has a home and every
capability has an owner.

**Guiding philosophy (verbatim):** *The system continuously acquires information,
develops understanding, answers questions, explores connections, resolves
uncertainty, improves itself, explains its actions, and rebuilds its knowledge as
better methods become available.*

The stages run **concurrently and continuously**, not in sequence: Ingest, Enrich,
and Reflect are always-on; Query/Explore happen on demand; Review/Audit/Replay are
oversight and longevity capabilities spanning the whole KB.

## 2. Cross-cutting infrastructure (not stages)

Power the stages but are not themselves lifecycle stages:

- **Orchestration** — the headless engine scheduling/running Enrich, automated
  Ingest, and Reflect as recurring jobs/agents (VISION-10).
- **Control Panel** — manage librarian agents, connect data sources, configure
  recurring tasks (VISION-11).
- **Vault / substrate** — the durable Obsidian-compatible markdown the stages read
  and write (VISION-12).

## 3. The eight stages

### Stage 1 — Ingest
*New information enters the system.* It may originate from the principal, automated
imports, external systems, agents, scheduled jobs, or other acquisition mechanisms.
**The primary responsibility of ingestion is preservation:** the system captures,
archives, and catalogs source material while preserving provenance and integrity.

**Jobs to be done:** acquire new information · preserve original artifacts · extract
basic metadata · establish provenance and lineage · make information available for
downstream processing.

> **Features:** Quick Capture · Rich Ingestion · Folder-Watch · Proactive Intake.

### Stage 2 — Enrich
*The system continuously develops understanding of its contents.* Librarian agents
examine newly ingested and existing information to extract entities, relationships,
concepts, summaries, classifications, and other derived knowledge. Enrichment is
ongoing and may be revisited as new information or improved techniques arrive.

**Jobs to be done:** extract entities and relationships · build and refine knowledge
structures · generate summaries and interpretations · link related information ·
expand contextual understanding.

> **Features:** Decompose & Catalog · Enrich & Research · Connect & Expand.

### Stage 3 — Query
*Knowledge is retrieved to answer questions and support decisions.* Multiple
retrieval methods, from natural-language questions to direct entity lookup and
structured exploration. **Every answer should provide traceability to supporting
evidence.**

**Jobs to be done:** answer questions · find relevant information · surface
supporting evidence · discover related concepts · support decision making.

> **Features:** Ask / Recall.

### Stage 4 — Explore
*Knowledge is examined beyond a specific question.* Multiple ways to navigate and
understand the state of the KB: graphs, timelines, entity views, relationship maps,
folders, tags, and recent activity. Exploration enables discovery that direct
querying alone would not.

**Jobs to be done:** discover connections · visualize relationships · identify
patterns · monitor knowledge growth · navigate unfamiliar areas.

> **Features:** Explore & Visualization (leans on the Vault substrate).

### Stage 5 — Review
*Ambiguity is resolved through collaboration with the principal.* When librarians
encounter uncertainty, missing context, conflicting interpretations, or incomplete
information, they **request clarification rather than make unsupported assumptions**.
**Responses become primary source material** and are incorporated into the KB.
Escalations range from the simple ("did Steve mean person X or Y?") to the open-ended
("you mentioned project Foo — what is that?").

**Jobs to be done:** resolve ambiguity · fill knowledge gaps · validate assumptions ·
improve accuracy · capture additional context.

> **Features:** Review & Disambiguation.

### Stage 6 — Reflect
*The system continuously evaluates and improves itself.* Librarians revisit existing
knowledge to identify stale information, emerging themes, missing relationships, weak
classifications, and opportunities for refinement. **Reflection focuses on the
quality and coherence of the KB as a whole** (vs. Enrich, which develops *new*
understanding of contents).

**Jobs to be done:** identify stale knowledge · refine classifications and metadata ·
discover emergent topics · improve coherence · maintain long-term quality.

> **Features:** Reflect (continuous self-maintenance; runs on Orchestration).

### Stage 7 — Audit
*The history of the system remains visible and explainable.* The principal and
librarians can inspect recent activity, transformations, decisions, workflows, and
changes — to understand how knowledge evolved and to diagnose issues.

**Jobs to be done:** inspect system activity · trace knowledge lineage · explain
decisions · diagnose errors · verify system behavior.

> **Features:** Audit & Activity (human-facing view onto provenance/lineage).

### Stage 8 — Replay
*Knowledge can be rebuilt as understanding improves.* As models, workflows, and
techniques evolve, the system can **reprocess preserved sources to generate improved
derived knowledge while preserving historical lineage**. Replay operates over **both
primary and secondary sources** (both are immutable/preserved) — it does **not** rely
solely on producing new secondaries, though it **may** produce new secondaries when
re-fetching or re-researching is warranted. Replay lets the KB evolve without losing
trustworthiness.

**Jobs to be done:** rebuild indexes and derived knowledge · reprocess historical
information · upgrade workflows safely · evaluate improved techniques · preserve
continuity across generations.

> **Features:** Replay & Reprocessing.

## 4. Requirements

| ID      | Priority | Statement (short)                                                | Verify   | Traces |
| ------- | -------- | ---------------------------------------------------------------- | -------- | ------ |
| LIFE-1  | must     | Ingestion is available to the Principal AND to automated actions/agents/cron | none-yet | VISION-1,3,7 |
| LIFE-2  | must     | On ingestion, data is archived as an immutable primary source, with provenance/lineage, before processing | none-yet | PRIN-1,5; VISION-4 |
| LIFE-3  | must     | Librarians enrich continuously: extract entities/relationships/summaries/classifications, link, expand context | none-yet | VISION-5,6; PRIN-3 |
| LIFE-4  | must     | Query supports multiple methods incl. NL; every answer provides traceability to supporting evidence | none-yet | VISION-9; PRIN-2 |
| LIFE-5  | must     | Explore offers multiple navigations: graphs, timelines, entity views, relationship maps, folders, tags, recent activity | none-yet | VISION-12 |
| LIFE-6  | must     | When uncertainty/missing/conflicting info is found, librarians request clarification rather than assume | none-yet | PRIN-4 |
| LIFE-7  | must     | Review escalations AND Principal responses are stored as primary sources | none-yet | PRIN-1; VISION-4 |
| LIFE-8  | should   | Reflect continuously evaluates KB quality/coherence: stale info, emergent themes, missing links, weak classifications | none-yet | PRIN-7,22 |
| LIFE-9  | must     | The Principal can inspect recent activity, transformations, decisions, workflows; trace lineage; diagnose | none-yet | PRIN-5,6 |
| LIFE-10 | must     | Preserved sources can be reprocessed to regenerate improved derived knowledge while preserving historical lineage | none-yet | PRIN-15; VISION-4 |
| LIFE-11 | must     | Replay operates over both primary AND secondary sources; it may, but need not, produce new secondaries | none-yet | PRIN-1,15 |
| LIFE-12 | must     | Replay supports BOTH full rebuild (discard + rebuild from scratch) AND partial/selective replay ("reingest these X") | none-yet | PRIN-15 |
| LIFE-13 | must     | Partial replay merges into the existing KB with preference to the new output, under heavy audit, routing conflicts through Review | none-yet | PRIN-2,5; LIFE-6,9 |

### LIFE-2 — Archive before processing
- **Status:** draft · **Priority:** must
- **Statement:** On ingestion, incoming data **MUST** be archived as an immutable
  primary source — with provenance and lineage established — **before** any
  enrichment, decomposition, or derivation touches it.
- **Rationale:** Replay (LIFE-10/11) and Ground Truth Is Sacred (PRIN-1) both depend
  on the original existing untouched, independent of whatever was later derived.
- **Traces:** PRIN-1, PRIN-5, VISION-4
- **Verify:** none-yet

### LIFE-7 — Clarifications are ground truth
- **Status:** draft · **Priority:** must
- **Statement:** Review escalations and the Principal's responses to them **MUST** be
  stored as primary sources in their own right.
- **Rationale:** The Principal's clarifications *are* new ground truth; preserving
  them makes the disambiguation itself replayable and auditable.
- **Traces:** PRIN-1, PRIN-2
- **Verify:** none-yet

### LIFE-10 — Replayable from preserved sources
- **Status:** draft · **Priority:** must
- **Statement:** The system **MUST** be able to reprocess preserved sources to
  regenerate improved derived knowledge (indexes, entities, summaries, links) as
  models/workflows improve, **while preserving historical lineage** (prior derived
  generations are not silently overwritten in the audit record).
- **Rationale:** Knowledge must outlive the models that processed it; the KB should
  be rebuildable as understanding improves, without losing trustworthiness.
- **Traces:** PRIN-4, PRIN-15, VISION-4
- **Verify:** none-yet

### LIFE-11 — Replay spans primary and secondary
- **Status:** draft · **Priority:** must
- **Statement:** Replay **MUST** be able to operate over **both primary and secondary
  sources** (both immutable/preserved) — e.g. re-deriving from previously fetched
  secondary data without re-fetching. Replay **MAY** produce **new** secondary
  sources (re-fetch / re-research) but **MUST NOT** depend on doing so.
- **Rationale (Principal):** Secondary sources are preserved ground-truth too;
  deterministic replay from them is valuable and must not require live re-fetching,
  while still allowing fresh research when warranted.
- **Traces:** PRIN-1, PRIN-15
- **Verify:** none-yet

### LIFE-12 — Two replay modes: full and partial
- **Status:** draft · **Priority:** must
- **Statement:** Replay **MUST** support two modes:
  - **Full replay** — discard the entire existing *derived* KB and rebuild it from
    scratch from the preserved primary + secondary sources.
  - **Partial / selective replay** — "reingest these X items" (a source, time
    window, project, entity subset) without rebuilding the whole KB.
- **Rationale (Principal):** Full rebuilds are the clean-slate upgrade path; partial
  replays are the day-to-day "this got better, redo just this" path.
- **Traces:** PRIN-15
- **Verify:** none-yet

### LIFE-13 — Partial replay merges, prefers new, audits, reviews
- **Status:** draft · **Priority:** must
- **Statement:** Partial replay **MUST** merge regenerated knowledge into the existing
  KB, giving **preference to the new output**, under **heavy audit**, and **MUST**
  route conflicts/ambiguities through the **Review** process (Stage 5) rather than
  silently overwriting.
- **Rationale (Principal):** A partial replay collides with knowledge the rest of the
  KB still references; new wins by default, but the collision is recorded (audit) and
  genuine conflicts are escalated to the Principal (review), preserving trust.
- **Traces:** PRIN-2, PRIN-5; LIFE-6, LIFE-7, LIFE-9
- **Verify:** none-yet

## 5. Stage → feature map

| Stage   | Features (own specs, TBD)                         | Cross-cutting deps |
| ------- | ------------------------------------------------- | ------------------ |
| Ingest  | Quick Capture · Rich Ingestion · Folder-Watch · Proactive Intake | Orchestration |
| Enrich  | Decompose & Catalog · Enrich & Research · Connect & Expand | Orchestration |
| Query   | Ask / Recall                                       | Vault |
| Explore | Explore & Visualization                            | Vault (Obsidian graph/bases) |
| Review  | Review & Disambiguation                            | Orchestration |
| Reflect | Reflect (self-maintenance)                         | Orchestration |
| Audit   | Audit & Activity                                   | provenance/event log |
| Replay  | Replay & Reprocessing                              | immutable primary + secondary archive |

## 6. Open questions

- [ ] **Ingest "catalog" target** — confirm "added to the ontology/index" = entities
      + links + metadata derived during/after archival.
- [x] **Enrich vs. Reflect boundary** — resolved: Enrich develops *new* understanding
      of contents; Reflect maintains *quality & coherence* of the whole.
- [x] **Review delivery surface** — resolved: escalations surface **in the app window
      UI** (a "needs you" / review queue), plus **notification batching** (dock badge,
      tray icon change). Detail belongs in the Review feature spec.
- [ ] **Audit vs. Replay substrate** — Audit *reads* lineage, Replay *re-executes*.
      Do they share one provenance/event log? (Likely yes.)
- [x] **Replay scope** — resolved (LIFE-12): supports **both** full rebuild and
      partial/selective replay.
- [ ] **Replay lineage model** — how are prior derived generations retained vs.
      superseded? Partial replay = "prefer new + audit + review" (LIFE-13); full
      replay = clean rebuild. Still open: are superseded derived generations *kept*
      (versioned/recoverable) or discarded once the new generation is accepted?
- [ ] **Explore: in-app vs. Obsidian** — primarily delegated to Obsidian (keep the
      vault rich), or does the app ship its own visual surface (timelines, relationship maps)?

## 7. Changelog

- 2026-05-30 — created (draft). Adopted the improved cyclical lifecycle (per-stage
  JtbD; "Rumination & Housekeeping" → **Reflect**). Defined LIFE-1..11; added LIFE-11
  for primary+secondary replay per the Principal. Mapped features to stages.
- 2026-05-30 — added LIFE-12 (full + partial replay modes) and LIFE-13 (partial-replay
  merge: prefer new, heavy audit, route conflicts through Review). Resolved review-
  delivery-surface and replay-scope open questions.
