---
spec: SPEC-0025
key: META
title: Rich Metadata, Tags & Properties
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-01
updated: 2026-06-01
related: [SPEC-0005, SPEC-0007, SPEC-0013, SPEC-0015, SPEC-0020, SPEC-0024, SPEC-0010]
stage: Enrich
supersedes: null
---

# Rich Metadata, Tags & Properties

> Layer rich, **Obsidian-native** metadata onto the KB — typed **Properties** (frontmatter) and
> structured **`tags:`** on sources, entities, claims, and outputs — so the vault powers
> **graph-view colors**, **Bases** dashboards, precise **filtering/search**, and **better
> recall**. A **hybrid vocabulary** (a small curated core the views rely on + LLM-coined
> emergent tags). Generated **authoritatively at Connect** (the sole writer of canonical nodes)
> and kept healthy by **Reflect**. v1 ships the metadata layer; generated Bases/graph views are
> a fast follow.

## 1. Intent (the why / JTBD)

Today the pipeline makes almost no metadata: an entity `kind` (Decompose), hardcoded source
`scope`/`sensitivity` defaults (Capture, CAPTURE-10), and identity `aliases` (Connect).
SPEC-0007 **models** entity attributes — DATA-3: *"nodes + typed Links + attributes
(metadata/tags/scope/sensitivity)"* — but its `Verify:` is `none-yet`. Modeled, not built.

Without rich metadata the vault can't do the things that make a second brain navigable:
**color the graph** by topic, build **filtered dashboards**, **search/filter** precisely, and
**ground recall** by facet. The job: *"make my KB richly navigable and filterable by
topic/type/time/facets — colored graph, dashboards, precise search — without me hand-tagging
anything."* This spec makes the pipeline **produce** that metadata in **Obsidian's native core
mechanisms** (Properties, Tags, Bases), so it works in plain Obsidian with no third-party
plugins.

## 2. The Obsidian representation (what we produce)

- **Properties** — typed YAML frontmatter: `text · list · number · checkbox · date · datetime`.
  The structured facet layer. Internal links must be quoted (`"[[X]]"`).
- **Tags** — the special **frontmatter `tags:` list**. v1 uses **`tags:` only, not inline
  `#tags`** in note bodies (hashtags inside *text* properties don't register as tags, and
  structured tags are cleaner to write programmatically and friendlier to Bases/search).
  **Nested** namespaces via `/` (`topic/ml`, `type/person`); no spaces; case-insensitive.
- **Bases** (`.base`) and **graph color groups** are the *consumers* (query by `file.hasTag(…)`,
  `tag:#…`, `path:…`). v1 produces the properties/tags they read; **generated views are a
  follow-up** (§7).

## 3. Vocabulary — hybrid (curated core + emergent)

- **Curated core** — a small, **versioned** set of properties + tag namespaces the views/colors
  depend on: e.g. `type` (person/org/project/…, seeded from entity `kind`), `topic/<…>`
  (nested), `status`, `scope`, `sensitivity`, and dates (`created`, `updated`). Stable contract.
- **Emergent** — beyond the core, the agent may **coin** topic tags / properties freely (like
  `kind` today). Captured and useful, but views/colors don't *depend* on them.
- **Reflect curates** the vocabulary (LIFE-8): consolidate near-duplicate tags, promote
  recurring emergent tags toward the core, flag drift — under the posture rules (destructive
  consolidation / schema change → Review).

## 4. Injection points (normal flow + Reflect)

| Stage | Emits | Notes |
| --- | --- | --- |
| **Capture/Ingest** | light **source** Properties (`class/kind/scope/sensitivity` + `created`) | present today (defaults); structured source `tags:` optional/light in v1 |
| **Decompose** | stays **thin** — `kind` only; **may surface tag *signals*** for Connect | candidates merge, so don't tag them |
| **Connect** ★ | **authoritative**: on minting/updating the canonical node, writes its **Properties + `tags:`** (type, topic/, scope, dates) | sole writer of `entities/` (CANON-5) — tags *resolved* nodes, not duplicates |
| **Claims** | may contribute **property signals** (e.g. confidence rollups) | claims already carry status/confidence |
| **Reflect** ★ | **ongoing**: tag/property hygiene + **emergent tagging** of under-tagged nodes + vocabulary curation | the "option" — additive auto, destructive/schema → Review |
| **Outputs** | tagged as **synthesis** (DATA-4) | distinct from ontology |

## 5. Requirements

| ID       | Priority | Statement (short)                                                                  | Verify   | Traces |
| -------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| META-1   | must     | Metadata is **Obsidian-native**: typed **Properties** (frontmatter) + tags as the frontmatter **`tags:` list**, on sources/entities/claims/outputs — works in **core Obsidian** (Properties/Tags/Bases), no third-party plugins | none-yet | DATA-3; VISION-12 |
| META-2   | must     | Tags/properties use a **hybrid vocabulary** — a small **curated core** (`type`, `topic/`, `status`, `scope`, `sensitivity`, dates) the views/colors depend on, plus **emergent** LLM-coined tags beyond it | none-yet | DATA-3; LIFE-8 |
| META-3   | must     | Tags use the **`tags:` frontmatter list** (not inline `#tags` in v1), **nested** with `/`, obeying Obsidian's no-space/valid-char rules | none-yet | VISION-12 |
| META-4   | must     | **Connect is the authoritative metadata writer**: minting/updating a canonical node writes its Properties + `tags:` in the **identity region**, disjoint from the claims block (SPEC-0020 region discipline) | none-yet | CONNECT-3; CANON-5 |
| META-5   | should   | **Capture** applies light source-level Properties (class/kind/scope/sensitivity + `created`); rich inference stays deferred (CAPTURE-10); **Decompose stays thin** (kind + optional tag signals) | none-yet | CAPTURE-10; DECOMP-1 |
| META-6   | must     | **Reflect maintains metadata** (SPEC-0024): tags under-tagged nodes, refreshes stale tags/properties, curates the vocabulary; **additive auto, destructive/schema → Review** | none-yet | LIFE-8; REFLECT-3,5 |
| META-7   | must     | Metadata writes are **disposition-governed** (AUTO): adding/auto-tagging is additive (auto, audited); removing/retagging/merging tags or changing the **curated schema** is destructive → Review (Guarded) | none-yet | AUTO-3,7 |
| META-8   | should   | The **curated-core** vocabulary is **versioned** (a small checked-in schema) so views/colors have a stable contract; **emergent** tags need no schema change | none-yet | DATA-3 |
| META-9   | should   | Metadata is **promoted to `main`** with its node (it lives in entity/source frontmatter — evergreen), visible in Obsidian | none-yet | STAGING-11 |
| META-10  | must     | Metadata writes are **audited/provenance-aware** — which stage/agent set a tag/property and why (AUTO-8); a Replay rebuild reproduces them (unmodified pipeline, REPLAY-14) | none-yet | AUTO-8; REPLAY-14 |

## 6. User flows / surface

- Open the vault → entity notes carry `type`, `topic/…`, `created/updated`, `scope` as
  Properties + a `tags:` list. Sources carry their class/kind/scope.
- **(Follow-up)** graph colored by `tag:#topic/…`; Bases dashboards filter
  `file.hasTag("type/person")`, `note.scope == "work"`, etc.
- **(Future)** Recall (Ask) constrains by properties/tags for sharper grounding.

## 7. Out of scope (for now)

- **Generated Bases views + graph color-group config** — a **fast follow** once metadata flows
  (this spec produces the metadata those consume). *(Principal decision: metadata now, views next.)*
- **Inline `#tags`** in note bodies — v1 is structured `tags:` only.
- **Rich scope/sensitivity inference** — still deferred (CAPTURE-10); v1 carries defaults plus
  whatever Connect infers cheaply.
- **Embeddings / semantic-similarity tagging infra** — lean on the LLM (consistent with Reflect).

## 8. Open questions

- [ ] **Curated-core set** — the exact v1 properties + tag namespaces, and their nesting.
- [ ] **Where the versioned core schema lives** — a checked-in `.kb/` schema file vs. a spec table.
- [ ] **Connect cheap-infer vs. defer-to-Reflect** — how much tagging Connect does per node
      (cost) vs. leaving it to a Reflect pass.
- [ ] **Property types for facets** — dates as `date`, confidence as `number`, scope as
      text/enum, etc.
- [ ] **Claim-level metadata** — do claims get their own tags/properties in v1, or only
      entities/sources?

## 9. Changelog

- 2026-06-01 — created (draft). Makes the pipeline **produce** Obsidian-native **Properties +
  `tags:`** (the layer DATA-3 modeled but left `none-yet`) so the vault powers graph colors,
  Bases dashboards, filtering/search, and recall — in **core Obsidian**. Forks resolved with the
  Principal: **hybrid vocabulary** (curated core + emergent), **frontmatter `tags:`** (not inline),
  **metadata now / generated views as a fast follow**. **Authoritative injection at Connect**
  (sole writer of canonical nodes), light at Capture, thin at Decompose, **maintained by Reflect**
  (SPEC-0024) — which is gated on this producer existing.
