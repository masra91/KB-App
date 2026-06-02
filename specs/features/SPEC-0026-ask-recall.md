---
spec: SPEC-0026
key: ASK
title: Ask & Recall (grounded NL query v1)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-01
updated: 2026-06-01
related: [SPEC-0003, SPEC-0004, SPEC-0005, SPEC-0006, SPEC-0007, SPEC-0014, SPEC-0020, SPEC-0025]
stage: Query
supersedes: null
---

# Ask & Recall (grounded NL query v1)

> The **"out" pillar**: the Principal asks the KB a natural-language question and gets a
> **grounded answer, traceable to evidence** — built by a **thick, structure-aware agent** that
> *navigates* the KB (entities, claims, `[[links]]`, metadata) with tools, **not blind
> text-search**. A **chat answer** by default, **savable as a persisted Output**. **Pull-only**.
> VISION-9 / LIFE-4.

## 1. Intent (the why / JTBD)

Half the product thesis is *"effortless recall out."* The enrich layer is now real on `main` —
deduped **entities** with their **claims**, `[[wikilinks]]`, and (SPEC-0025) **Properties/tags**.
Recall is the **payoff** that turns all that work into value to the Principal.

The job: *"ask in my own words and get back a rich, grounded answer full of **what and why**,
traceable to real evidence — without me searching, filtering, or remembering where anything
is."* (The day-in-the-life of SPEC-0003: fragments sent in come back as full quotes, context,
definitions, and connected prior work.)

## 2. The shape of a recall

- **Input** — an NL question, with conversational follow-ups.
- **Output** — a **grounded chat answer** by default; the Principal can **save it as an Output**
  (persisted synthesis under `outputs/`, **tagged as synthesis** with provenance — DATA-4 —
  promoted to `main`, evergreen). It re-enters the KB.
- **Grounded** — every substantive assertion **cites its evidence** (links to the
  source/claim/entity it rests on). No ungrounded claims presented as fact (PRIN-2, VISION-9).
- **Pull-only** — Principal-initiated; the KB never auto-pushes answers (AUTO-5).
- **Read-only w.r.t. the ontology** — recall reads sources/entities/claims; it **MUST NOT**
  mutate them. Its only write is the optional Output.

## 3. Agentic, structure-aware retrieval (the core idea)

Recall is **not** a fixed retrieve-then-synthesize pipeline over plain text. We have a rich,
structured, metadata-tagged graph and a capable agent — the agent should **exploit that
structure**. The recall agent is a **thick** GHCP/Copilot session (the SPEC-0014 harness, with
a larger budget than a stage) equipped with:

- **A recall skill / instruction file** teaching the **KB's structure**: the
  `sources/ entities/ claims/ outputs/` layout, the **metadata/tags/properties** model
  (SPEC-0025), the `[[wikilink]]` graph, and **provenance conventions** — so it navigates
  intentionally.
- **Tools it chooses among, per question:**
  - **structured KB queries** — entity lookup by name/alias, **tag/property filters**, claim
    lookup by subject, **`[[wikilink]]` graph traversal**;
  - **full-text** grep / ripgrep;
  - **optional Obsidian CLI** acceleration (its live index) **when Obsidian is running** —
    capability-detected, **never required**.
- It performs **multi-hop, entity-centric retrieval** — find the entity → read its claims →
  follow its links → check sources/metadata — reasoning about relevance, not dumping text.

> The point: *agents, not plain-text search.* Embeddings / a semantic index are a **possible
> later** enhancement (no timeline); v1 is structured + lexical + agent reasoning.

## 4. Requirements

| ID      | Priority | Statement (short)                                                                  | Verify   | Traces |
| ------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| ASK-1   | must     | The Principal can ask an **NL question** and receive a **grounded answer traceable to evidence** (links to the sources/claims/entities it rests on) | none-yet | VISION-9; LIFE-4; PRIN-2 |
| ASK-2   | must     | Recall is **pull-only** — Principal-initiated; the KB never auto-pushes answers/reports | none-yet | AUTO-5 |
| ASK-3   | must     | Recall is **read-only w.r.t. sources/entities/claims** — it MUST NOT mutate the ontology; its only write is an optional **Output** | none-yet | DATA-1; AUTO-6 |
| ASK-4   | must     | Answers are produced by a **structure-aware agent** with a recall **skill** (KB layout + metadata/tags/properties + wikilink/provenance) and **tools** (structured KB queries, grep, optional Obsidian CLI), choosing among them per question — **not blind text-search** | none-yet | ORCH-5,7,9; META-1 |
| ASK-5   | must     | Retrieval is **multi-hop, entity/metadata-aware** — traverses entities → claims → `[[wikilinks]]`, filters by tags/properties, exploiting KB structure | none-yet | CONNECT-3; META-1,3 |
| ASK-6   | must     | The Principal can **save an answer as an Output** — persisted under `outputs/`, **tagged as synthesis** with provenance to its evidence, promoted to `main` | none-yet | DATA-4; STAGING-3 |
| ASK-7   | must     | Every substantive assertion **cites its evidence**; the agent MUST NOT present ungrounded claims as fact, and **distinguishes KB-grounded from inferred** | none-yet | PRIN-2; VISION-9 |
| ASK-8   | should   | Recall is **conversational / multi-turn** — follow-ups refine within a session (the Ask/Chat surface) | none-yet | VISION-9; SHELL |
| ASK-9   | should   | **Obsidian CLI acceleration** is capability-detected and **never required** — core recall stays **headless** and works with Obsidian absent (optional viewer) | none-yet | STACK; PRIN-5 |
| ASK-10  | should   | Recall honors **scope/sensitivity + surfacing** — answers respect the surfacing policy and scope partitions | none-yet | SCOPE-11; SCOPE-1 |
| ASK-11  | must     | A recall run **emits an audit event** (question, what it retrieved, what it answered/saved) for transparency | none-yet | AUTO-8; LIFE-9 |
| ASK-12  | should   | Ask/Recall is the **first Copilot SDK pilot** (ORCH-21/22): it runs on the **SDK** (Sessions/tools/streaming) behind the agent interface — because tools (ASK-4), multi-turn (ASK-8), and streaming are load-bearing here — with the **deterministic/CLI fallback** retained; the SDK is **pinned + version-aged** (E1, not the SDK's sole user — adopt elsewhere where it makes sense) | none-yet | ORCH-21,22; ENG-7 |

## 5. User flows / surface

- **Ask UI** (chat-like, SPEC-0003 §4): type a question → grounded answer **with citations** →
  optionally **"save as report"** (Output).
- **Multi-turn** follow-ups within a session.

## 6. Out of scope (for now)

- **Embeddings / semantic index** — a possible later enhancement, **no timeline** (v1 is
  structured + lexical + agent reasoning).
- **Audience-facing export/sharing** of outputs beyond saving them in the vault.
- **Proactive / pushed answers** — pull-only (AUTO-5).
- **Cross-Instance / multi-scope federation** beyond honoring scope (SPEC-0005).
- **Any write-back beyond Outputs** — recall never mutates sources/entities/claims.

## 7. Open questions

- [ ] **Output template** — the saved report's markdown structure, sections, and how citations
      render (`[[wikilinks]]` / block-quotes / footnotes).
- [ ] **Grounding vs. reasoning** — how far the agent may reason beyond the KB, and how it
      **labels** inferred-vs-grounded content (ASK-7).
- [ ] **Retrieval budget** — the cost bound on the thick agent per question (breadth/hops).
- [ ] **Does a saved Output get re-enriched?** — is an Output a source-like input that
      Decompose/Connect process, or inert synthesis? (DATA-4; the loop.)
- [ ] **Structured-tool surface** — the exact KB query tools we build for the agent.
- [ ] **Session state** — where conversational context lives (ephemeral vs saved).

## 8. Changelog

- 2026-06-01 — created (draft). The "out" pillar (VISION-9): NL question → **grounded, cited**
  answer by a **structure-aware thick agent** that wields tools (our structured KB queries,
  grep, **optional** Obsidian CLI) plus a recall **skill** teaching the KB's structure/metadata
  — **agentic, multi-hop, not plain-text search**. Chat answer by default, **savable as an
  Output** (DATA-4). Pull-only, read-only w.r.t. the ontology, epistemically honest. Forks
  resolved with the Principal: **chat + save-as-Output**; **hybrid retrieval** (in-house
  structured+lexical tools now; the official **Obsidian CLI needs a running app** so it stays an
  **optional accelerator**, preserving headless/Obsidian-optional; embeddings maybe-later, no
  timeline); **agentic structure-aware retrieval — agents, not plain search.** Researched the
  Obsidian CLI (shipped v1.12.4, Feb 2026 — remote-controls a running app) and headless
  alternatives.
