---
spec: SPEC-0051
key: COHERE
title: Graph Cohesion — linking, orphan-resolution & structural dedup (communities, not islands or a hairball)
type: feature
status: draft
owners: [KB-Lead, Principal]
related: [SPEC-0020, SPEC-0016, SPEC-0024, SPEC-0046, SPEC-0047, SPEC-0050]
created: 2026-06-14
stage: Cross-cutting
supersedes: null
---

# Graph Cohesion — communities, not islands or a hairball

> Today the entity graph is ~**99.7% orphans** (6 of ~911 entities have any entity↔entity link)
> despite rich sources/claims — and it carries cross-name dupes (`Magic` vs `Magic The Gathering`,
> `Caroline` vs `Caroline Winters Allen`, `SharePoint` vs `ODSP`). The goal is the **middle**: distinct,
> internally-dense **subgraphs** (work, travel, MTG, family…) that stay **mostly disconnected from each
> other** — cross-cluster edges are rare and only through **genuinely universal connectors** (the
> Principal/"me", a pervasive theme). **High modularity is the target; a fully-connected hairball is a
> failure mode to avoid just as much as islands.**

## 1. The shape we want (the core principle)
- **Dense within a community, sparse between.** Link an orphan into *its own* cluster, around a
  **gravity hub** (the cluster's central node) — never bridge unrelated clusters on weak signal.
- **Cross-cluster links are the rare, high-bar case.** A link that would *bridge two otherwise-separate
  communities* is structurally significant → it needs **higher confidence** (likely a coincidence
  otherwise) and is reserved for **universal connectors** (you, or a near-universal theme) — everything
  else stays in-cluster.
- **Topical tags ARE the community labels.** The content tags (work / travel / MTG / coding / AI —
  the topical-tagging workstream) define communities the linker respects: prefer within-shared-tag
  links; cross-tag links are the skeptical case. Tagging + linking reinforce each other.
- **Never the two failure modes:** islands (current) OR a hairball (over-linking). Both are regressions.

## 2. The four passes (build order)
1. **Fix link-promotion (foundational, free).** The grounded signal already exists — ~500 `relatesTo`
   hints extracted, ~6 rendered. Turn type-2 promotion on (Claims hints → `[[wikilinks]]`). 6 →
   hundreds of links by itself; everything below stands on this. *(slice 1)*
2. **Orphan-RAG linker (librarian job, Reflect-style).** Take an orphan/low-degree node, retrieve
   candidate entities (name-overlap + centrality), have the model judge links — **hub-preferred,
   degree-capped, high-bar**, **within-community by default**. Confidence-gated on the SPEC-0047 line:
   high → auto-link; ambiguous → review; a `distinct` directive (SPEC-0050) suppresses a wrong one.
   **No embeddings v1** (LLM-as-retriever-judge); embeddings are a later recall/scale option (fork).
3. **Structural dedup.** Once links exist, **shared-neighbor overlap + fuzzy name** flags cross-name
   dupes that block-key clustering NEVER compares (`Magic`/`Magic The Gathering`, `SPO`/`SharePoint
   Online`). Confidence-gated → merge or a `merge`/`alias` directive. **Sequenced after linking.**
4. **Alias directives + decompose-time canonicalization (dupe *prevention*).** `alias` directives
   ("SPO = SharePoint Online") let Decompose fold a known alias at extraction so the dupe never forms;
   the structural-dedup pass can *propose* aliases for the Principal to confirm.

## 3. Anti-saturation rules (enforce the modularity target)
- **Hub-preference:** attach to the cluster's central node, not to every co-member.
- **Degree cap + high relevance bar:** top-K, link only the few clearing a high threshold; rest get nothing.
- **Bridge guard:** a proposed link joining two separate communities requires markedly higher
  confidence and is allowed mainly via universal connectors; otherwise drop or review.
- **Universal-connector concept:** some nodes (the Principal/"me", pervasive themes) legitimately span
  clusters — they're the sanctioned bridges; flag/allow them explicitly, treat all other bridges skeptically.

## 4. Measure the outcome (eval surface, SPEC-0047)
Turn "feels like islands / hairball" into numbers, guarding BOTH extremes:
- **orphan %** (drive down from ~99.7%), **avg/median degree**, **dupe rate** (drive down).
- **Modularity (Q) / community count** + **cross-cluster edge ratio** (must stay LOW — the hairball guard).
- **Largest-connected-component share** (a single giant component swallowing everything = regression).

## 5. Requirements (must unless noted) — `Verify: none-yet → test:`
- **COHERE-1** Link-promotion converts `relatesTo` hints → wikilinks (foundational). *(slice 1)*
- **COHERE-2** An orphan-resolution librarian job proposes links **hub-preferred, degree-capped,
  high-bar, within-community by default**, confidence-gated (auto/review) + directive-suppressible.
- **COHERE-3** **Bridge guard:** a cross-community link requires higher confidence; spurious
  cross-cluster linking is prevented (the hairball guard). *(the Principal's central caution)*
- **COHERE-4** Structural (shared-neighbor + fuzzy-name) dedup flags cross-name dupes block-key
  clustering misses; confidence-gated coalesce → merge/alias directive.
- **COHERE-5** `alias` directives + decompose-time canonicalization prevent known-alias dupes forming.
- **COHERE-6** Graph-cohesion metrics (orphan %, degree, dupe rate, **modularity, cross-cluster ratio,
  giant-component share**) are tracked in the eval surface and gate against BOTH islands and hairball.

## 6. Forks
- **F1 — sequencing:** 1→2 first (richen), then 3 — vs run 3 (dedup) in parallel to collapse obvious
  dupes now. **Rec: 1→2 first** (structural dedup is far stronger once links exist). ✅ (Principal-aligned)
- **F2 — embeddings:** LLM-as-retriever-judge v1 (no vector store) vs an embedding index for semantic
  recall (better SPO↔SharePoint matching at scale). Rec: v1 lean; embeddings as a later scale option.

## 7. Slicing
- **Slice 1:** COHERE-1 (fix link-promotion) — foundational, immediate density.
- **Slice 2:** COHERE-2/3 (orphan-linker + bridge guard) + COHERE-6 metrics.
- **Slice 3:** COHERE-4/5 (structural dedup + alias/canonicalization).
