---
spec: SPEC-0007
key: DATA
title: Core Data Model (Sources, Entities, Outputs)
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0001, SPEC-0002, SPEC-0004, SPEC-0005, SPEC-0006]
supersedes: null
---

# Core Data Model (Sources, Entities, Outputs)

> The three kinds of content in the KB, how they relate by provenance, and how the
> whole thing is versioned. Resolves **Fork 3**. *Physical layout (file structure,
> markdown shape) is architecture — deferred.*

## 1. Intent (the why / JTBD)

Every feature reads and writes this model, so it must be pinned before feature specs.
The model has to make the principles concrete: ground truth preserved, derived
knowledge traceable and uncertainty-aware, everything versioned and recoverable.

## 2. The three kinds (distinct by mutability)

Sources and Entities are **distinct, never collapsed into one**. The dividing line is
**mutability**:

### Sources — immutable, append-only ground truth
Primary (from the Principal) and Secondary (from external queries). **Never edited.**
The archive that Replay replays (LIFE-2/10/11). Committed once; effectively write-once.

### Entities — the versioned knowledge graph (ontology)
The **nodes**: concepts, events, people, places, organizations, projects, … Derived
from Sources, **versioned**, and carrying:
- **Links** — typed semantic edges to other entities and to sources (provenance).
- **Attributes** — Metadata, Tags, Scope, Sensitivity (SPEC-0005).
- **Epistemic attributes** — status, confidence, evidence (see §4).

This is the living "understanding" — what Query and Explore operate over.

### Outputs — persisted synthesis artifacts
Reports, answers, summaries — produced on demand (Query) or by enrichment. **Persisted
permanently** but **clearly tagged as *synthesis output*** so they are never confused
with ontology or sources. Governed by the surfacing policy (SCOPE-11).

> **"Derived artifact"** (glossary) is the umbrella for everything below the Source
> line — both **Entities** and **Outputs** are derived and carry provenance to Sources.

```
SOURCES (immutable)  ──derived-from──►  ENTITIES (versioned)  ──built-from──►  OUTPUTS (synthesis, tagged)
 primary | secondary                    nodes + links + attrs                  reports | answers
```

## 3. Provenance

Every Entity and Output records **provenance**: `derived-from` links to the Sources
(and intermediate Entities) it came from, plus the **transforming agent/workflow**.
This lineage is the backbone Audit *reads* and Replay *re-executes* (PRIN-2/5).

## 4. Epistemic attributes (evidence over confidence)

Derived knowledge — entities, individual **claims/assertions**, and **links** — carries:

- **Status** — `fact` | `interpretation` | `hypothesis` (PRIN-3).
- **Confidence** — a calibrated degree of belief (PRIN-11).
- **Evidence** — links to the supporting sources/entities (PRIN-2/10).

Kept deliberately **lightweight**: these are attributes + provenance links, not a heavy
separate subsystem. Low-confidence **links** are marked speculative and routed to Review
(SCOPE-5); low-confidence **classifications** route to Review (SCOPE-9). This is how the
KB "prefers evidence over confidence" and "surfaces uncertainty" in practice.

## 5. Entity kinds — open & emergent

The set of entity *kinds* is **open, extensible, and emergent** — **defined by agents,
curated** over time. A sensible **base set** ships (concept, event, person, place,
organization, project, …), but **not every KB will have every kind**, and new kinds
arise from the material itself.

## 6. Versioning & recovery — git-backed

- The KB **lives in a git repository** — **local minimum, optional remote** (per
  Instance; Work and Personal may differ or have none).
- **Git is the versioning substrate**: agents **commit** changes and **manage dirty
  state**. Sources are write-once; Entities/Outputs version through commits.
- **Commits are audit events** — the audit log links to commit SHAs. But the **audit
  log is a strict superset of git history**: beyond file changes it records
  **non-mutating actions** (reads, searches), **agent decisions**, and **light
  snapshots of thought/intent** — the ***why*** behind actions, not just the *what*.
  Git can only show diffs; the reasoning lives in the audit log (PRIN-5, PRIN-22).
- **Superseded derived generations live in git history** — kept, recoverable; this
  answers the Replay-lineage question and enables rollback when Audit finds incoherence.
- **Open & durable** (PRIN-4/13): markdown + git is tool-independent and portable.

> Detailed git mechanics — commit strategy, concurrency/serialization for multiple
> agents, conflict resolution, branch model — are **architecture, deferred** (§8).

## 7. Requirements

| ID       | Priority | Statement (short)                                                  | Verify   | Traces |
| -------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| DATA-1   | must     | Three distinct kinds: Sources (immutable), Entities (versioned), Outputs (persisted synthesis); Sources & Entities are never collapsed | none-yet | PRIN-1,7 |
| DATA-2   | must     | Sources (primary + secondary) are immutable and append-only         | none-yet | PRIN-1; LIFE-2 |
| DATA-3   | must     | Entities are the ontology: nodes + typed Links + attributes (metadata/tags/scope/sensitivity), versioned | none-yet | PRIN-7; LIFE-3 |
| DATA-4   | must     | Outputs are persisted permanently, tagged as synthesis, distinct from ontology/sources, surfacing-governed | none-yet | SCOPE-11; VISION-9 |
| DATA-5   | must     | Every Entity and Output records provenance: derived-from links + transforming agent/workflow | none-yet | PRIN-2,5; PRIN-10 |
| DATA-6   | must     | Entity kinds are an open, extensible, emergent, agent-curated set with a base set | none-yet | PRIN-3 |
| DATA-7   | should   | Derived knowledge (entities/claims/links) carries status (fact/interpretation/hypothesis), confidence, and evidence | none-yet | PRIN-3,11; PRIN-2 |
| DATA-8   | must     | Links carry confidence; speculative links are marked, not asserted | none-yet | PRIN-4; SCOPE-5 |
| DATA-9   | must     | The KB is versioned via a git repository (local minimum, optional remote); agents commit and manage dirty state | none-yet | PRIN-4,7,13 |
| DATA-10  | must     | Commits are audit events linked from the audit log; the audit log is a superset — also recording non-mutating actions, agent decisions, and thought/intent (the *why*) | none-yet | PRIN-5,6,22; LIFE-9 |
| DATA-11  | should   | Git history retains superseded derived generations, enabling recovery/rollback and Replay lineage | none-yet | PRIN-8; LIFE-10 |

### DATA-1 — Three kinds, distinct by mutability
- **Status:** draft · **Priority:** must
- **Statement:** The KB **MUST** distinguish three kinds of content — **Sources**
  (immutable), **Entities** (versioned), **Outputs** (persisted synthesis) — and
  **MUST NOT** collapse Sources and Entities into a single kind.
- **Rationale:** Mutability *is* the meaning: immutable ground truth vs. living
  understanding vs. on-demand synthesis. Collapsing them breaks Replay and the
  immutability guarantee.
- **Traces:** PRIN-1, PRIN-7, VISION-4
- **Verify:** none-yet

### DATA-9 — Git-backed versioning
- **Status:** draft · **Priority:** must
- **Statement:** The KB **MUST** be stored in a git repository (local required, remote
  optional per Instance). Agents **MUST** commit their changes and manage dirty working
  state so history is coherent.
- **Rationale:** Git gives versioning, history, recovery, and a durable open format for
  free; commits double as audit events.
- **Traces:** PRIN-4, PRIN-7, PRIN-8, PRIN-13
- **Verify:** none-yet

## 8. Open questions

- [ ] **Epistemic granularity** — do status/confidence/evidence attach at the **entity**
      level, the **claim/assertion** level, or both? (Leaning: both, with claims
      lightweight. Pin when the Enrich feature is specced.)
- [ ] **Git concurrency strategy** *(architecture)* — how do multiple agents commit
      safely? Serialized writer? Per-agent staging/branches? Conflict resolution policy?
- [ ] **Commit granularity** *(architecture)* — one commit per agent action? per
      workstream? per batch? Affects how cleanly audit ↔ git maps.
- [ ] **Output ↔ entity boundary** — when synthesis produces something durable enough to
      become ontology (an Output that *is* new knowledge), does it get promoted to an
      Entity, or stay an Output with links? 
- [ ] **Source ↔ Entity provenance shape** — is the `derived-from` graph itself stored
      as Links, or as separate provenance metadata? (Likely Links; confirm.)

## 9. Changelog

- 2026-05-30 — created (draft). Resolved Fork 3. Three kinds distinct by mutability
  (Sources/Entities/Outputs); provenance backbone; epistemic attributes
  (status/confidence/evidence); open emergent entity kinds; **git-backed versioning**
  with commits-as-audit-events and history-as-replay-lineage.
