---
spec: SPEC-0001
key: LANG
title: Ubiquitous Language (Glossary)
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0002]
supersedes: null
---

# Ubiquitous Language (Glossary)

> The canonical vocabulary of the Knowledge Base. These words mean exactly one
> thing across every spec, agent prompt, UI string, and line of code. When we
> disagree about a word, we change it *here* first.
>
> **User-facing display name:** internally the concept is the *Knowledge Base*; in the **UI it is
> always the "Library"** (Vellum is the product; the Library is what it tends) — the acronym **"KB"
> is banned from every user-facing string**. See `specs/design/terminology.md` §0 for the display
> law and scrub sites.

## 1. Intent (the why / JTBD)

A knowledge system that mixes AI agents and a human principal will drift into
ambiguity fast — "source", "note", "entry", "doc" all blur together. A shared,
precise vocabulary is the cheapest durability investment we can make: it keeps
agents aligned, makes provenance language exact, and lets specs reference concepts
without re-defining them.

This is a **reference** spec. Other specs and code are expected to use these terms
verbatim. Normative *behavior* about these concepts (e.g. "sources are immutable")
lives in [SPEC-0002 Principles](SPEC-0002-knowledge-system-principles.md), not here.

## 2. Scope

**In scope:** the core nouns/roles of the KB and their precise meanings.

**Out of scope:** behavior, rules, flows, and tech — those live in other specs.

## 3. Terms

> Definitions are quoted/condensed from the Principal. Where a definition was
> incomplete, it is marked and captured as an open question rather than invented.

### Knowledge Base (KB)
The collective whole of the application: the experience, all related flows, files,
and technology. "The KB" refers to the entire system, not just stored data.

### Principal
The key (human) user and owner of the KB. Currently: **Mason Allen**. The
principal is the ultimate authority and the source of all primary material.

### Agent
An LLM agent working in or with the KB. Agents may have specialized roles (defined
later). *(The KB-Architect is one such agent.)*

### Librarian
A class of agent that works **inside** your KB — the pipeline workers that **store and
curate** information, **enrich** topics, and **answer questions** (archivist, decompose,
connect, claims, reflect, ask). Built in → **disable-only** (not removable). *(A
specialization of Agent. In the UI, "Agents → Librarians" — SPEC-0053.)*

### Researcher
A class of agent that reaches **outside** your KB — outward, **egress-gated** agents
(Web / Code / M365·WorkIQ) that fetch external corroboration and bring back cited
sources. User-added → **removable** (with a destructive-action confirm). *(A
specialization of Agent, distinct from Librarian by direction — outward vs inward.
SPEC-0053 / SPEC-0028.)*

### Schedules
**When** recurring librarian work runs (e.g. Reflect rumination) — a cadence + autonomy
posture on an autonomous task. Formerly surfaced as **"Jobs"**; renamed **Schedules** and
nested under Librarians in the Agents hub. *(SPEC-0053; the engine is SPEC-0023.)*

### Entity
An entry in the KB — e.g. a concept, an event, … *(definition trails off in source;
see open questions — the full set of entity kinds and the source↔entity relationship
are undecided).*

### Metadata
Invisible data applied to an entity, used for searching, filtering, etc., kept
**separate from the content itself**. (Not shown as part of the entity's body.)

### Tag
A label applied to an entity to indicate **non-hierarchical / set-like**
relationships between entities.

### Link
A **semantic** relationship between entities, expressed as a hyperlink. Carries
meaning, not just navigation.

### Primary source
Data or information provided to the KB **directly by the principal**. Primary
sources are **preserved and immutable**.

### Secondary source
Data or information provided to the KB by **external queries** from agents,
researchers, etc. Secondary sources are **preserved and immutable**.

### Derived artifact
Anything an agent *produces* from sources/entities — summaries, interpretations,
classifications, answers, reports, links. Derived artifacts are **not sources of
truth** (PRIN-9); they preserve links to their supporting evidence and inherit the
sensitivity of their sources (see Sensitivity). *(Added per SPEC-0005.)*

### Instance (Deployment)
One installation of the app bound to **one vault** plus its own agents, sources, and
config, on one machine / trust domain. Instances are **hard-isolated** — no automatic
data flow between them (e.g. a Work instance vs. a Personal instance). *(SPEC-0005.)*

### Scope
A **user-defined area** an entity belongs to and that an agent/source/task can be
**bound to** (e.g. `Project Atlas`, `Journal`). Default is `global`. A *governed*
construct (it affects behavior), distinct from a Tag (descriptive). *(SPEC-0005.)*

### Sensitivity
A **classification label** on an entity governing what may appear in outputs
(`shareable`, `internal`, `confidential`, `private-opinion`, `embargoed`, + custom).
Default on capture is `internal`. Propagates up the derivation chain. *(SPEC-0005.)*

### Surfacing policy
The rule set that decides what a derived **output** may include: each output declares
an audience/purpose with an allowed **sensitivity ceiling**, and excludes content
that exceeds it (Principal may override). *(SPEC-0005.)*

### Output (Synthesis output)
A persisted **derived artifact** produced *for an audience* — a report, answer, or
summary. Tagged as **synthesis output**, distinct from entities (ontology) and sources.
Produced on demand (Query) and governed by the surfacing policy. *(SPEC-0007.)*

### Provenance (Lineage)
The recorded `derived-from` trail from any Entity/Output back to the Sources (and
intermediate entities) and the transforming agent/workflow that produced it. The
backbone Audit reads and Replay re-executes. *(SPEC-0007.)*

### Evidence
The specific sources/entities that **support** a claim, entity, or link — recorded as
links. "Prefer evidence over confidence" (PRIN). *(SPEC-0007.)*

### Confidence
A calibrated degree of belief attached to derived knowledge (entities, claims, links).
Low confidence surfaces to Review rather than being asserted. *(SPEC-0007.)*

### Status (epistemic)
Whether a piece of derived knowledge is a `fact`, an `interpretation`, or a
`hypothesis` (PRIN-3). *(SPEC-0007.)*

## 4. Requirements

| ID     | Priority | Statement (short)                                        | Verify   |
| ------ | -------- | -------------------------------------------------------- | -------- |
| LANG-1 | should   | Specs, prompts, UI, and code use these canonical terms    | manual:review |
| LANG-2 | should   | New domain nouns are added here before being used elsewhere | manual:review |

### LANG-1 — One word, one meaning
- **Status:** draft · **Priority:** should
- **Statement:** All specs, agent prompts, UI copy, and code **SHOULD** use the
  terms defined here with these meanings, and **SHOULD NOT** introduce synonyms for
  defined concepts.
- **Rationale:** Ambiguous vocabulary is the root cause of provenance and agent drift.
- **Verify:** manual:review

### LANG-2 — Glossary leads usage
- **Status:** draft · **Priority:** should
- **Statement:** A new core domain noun **SHOULD** be defined here before it is
  used in another spec or in code.
- **Rationale:** Keeps the ubiquitous language actually ubiquitous over time.
- **Verify:** manual:review

## 5. Open questions

- [x] **Entity kinds** — resolved (SPEC-0007): an **open, emergent, agent-curated**
      set with a sensible base (concept, event, person, place, organization, project, …);
      not every KB has every kind.
- [x] **Source vs. Entity relationship** — resolved (SPEC-0007): **distinct kinds**,
      separated by mutability. Sources are immutable; Entities are versioned and
      *derive from* sources. Never collapsed.
- [x] **Derived artifacts** — resolved: added as a glossary term (per SPEC-0005),
      distinct from Entity and Source.
- [x] **Researcher** — resolved (SPEC-0053): a **distinct** agent specialization, separated
      from Librarian by **direction** (outward/egress-gated vs inward pipeline work). Added as a
      glossary term.
- [ ] Is there a term for the **vault / store** (the durable file substrate) vs.
      the KB-as-whole-system?

## 6. Changelog

- 2026-06-27 — **SPEC-0053 WS-E naming** (AGENTSIA-6): framed **Librarian** as inward
  (built-in, disable-only); added **Researcher** (outward, egress-gated, removable) and
  **Schedules** (formerly "Jobs", nested under Librarians) as terms; resolved the open
  "is Researcher distinct?" question (yes — by direction). Mirrors the Agents-hub IA.
- 2026-05-30 — created (draft). Captured initial terminology from the Principal.
