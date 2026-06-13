---
spec: SPEC-0046
key: COMPOSE
title: Encyclopedic Entity Pages (Compose — the human-readable top layer)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-08
updated: 2026-06-08
related: [SPEC-0002, SPEC-0007, SPEC-0016, SPEC-0019, SPEC-0020, SPEC-0024, SPEC-0026, SPEC-0031]
stage: Enrich
supersedes: null
---

# Encyclopedic Entity Pages (Compose)

> Make the top-level entity pages read like **Wikipedia**, not a metadata dump: a **Title-Case
> human name**, **prose with section headers**, **inline `[1][2]` citations** → a References
> section, and **entity links woven into the prose** — while keeping the structured links/claims
> blocks **below** for RAG. **Grounded**: every prose sentence is synthesized from the entity's
> existing **cited claims** — no new facts, no egress, fully traceable. (Principal: entity pages
> are "ugly and bland"; ties to the human-readable theme, PRIN-24.)

## 1. Intent (the why)

Today an entity page (`connectDoc.ts`) is **frontmatter + an H1 + a links block + a claims block** —
no prose. Opened in Obsidian it reads as a machine manifest: a blob of `[[claim-ULID]]` rows, not a
page a human *reads*. And the **filename is a kebab-slug** (`steve-jobs.md`) — part of the same
ugly-IDs problem (PRIN-24). The Principal wants to glance at an entity and **understand it** —
encyclopedically — without clicking through every claim and source.

The KB already has everything needed: **Claims** (SPEC-0016) carry substance + citations; **Connect**
links entities. What's missing is the **human layer** — a stage that **composes** the cited claims
into readable prose. This is a presentation/synthesis layer over grounded data, not new knowledge.

## 2. Target shape

```markdown
---
id: 01J…                 # ULID stays internal (identity/alias) — NEVER the filename or display
name: Steve Jobs
kind: person
[…provenance, tags…]
---

# Steve Jobs                                    ← filename is "Steve Jobs.md" (Title-Case, PRIN-24/CANON-6)

Steve Jobs co-founded [[Apple]] in 1976[^1] and led its product vision through the
2000s[^2]. He was known for an uncompromising design philosophy[^1].

## Founding Apple
In 1976 Jobs started Apple with [[Steve Wozniak]] in his family garage[^1]…

## Leadership
…served as CEO[^2], championed the original Macintosh[^3]…

## References
[^1]: [[Apple keynote notes (2026-05-30)]]      ← human source TITLE, not a ULID
[^2]: [[Q3 board memo (2026-05-31)]]
[^3]: …

<!-- kb:links:start (generated) -->                ← structured blocks KEPT below, for RAG
- founded [[entities/organization/Apple.md|Apple]]
<!-- kb:links:end -->
<!-- kb:claims:start (generated) -->
- … (each claim, status, confidence, cited source)
<!-- kb:claims:end -->
```

Two layers, both intact: a **human prose layer** on top (the encyclopedia), the **structured
links/claims blocks** below (the machine/RAG layer). The prose is the read; the blocks are the index.

## 3. Grounding (the non-negotiable)

The prose is **synthesis, not generation**: every sentence is composed **only** from the entity's
existing **cited claims** (SPEC-0016). The Compose agent **may not introduce a fact that isn't
already a claim** — it structures, orders, and phrases what's there. So:
- every prose statement **traces to a claim → a source** (PRIN-2, PRIN-10);
- the inline `[n]` citations map to those sources (the References section);
- a prose sentence with **no citation is a defect** (an un-grounded claim);
- **no new egress** — Compose reads internal claims only (unlike Research).

This keeps PRIN-1/9 intact (AI is operator not authority; the prose is a *derived* presentation of
cited evidence, never a new source of truth) and makes the encyclopedic page as trustworthy as the
claims under it.

## 4. The Compose stage

A **new final Enrich stage, after Claims** (KB-Lead lean — fork in §7): `Decompose → Connect →
Claims → **Compose**`. It reads an entity + its cited claims and **(re)writes the prose body** (the
region above the structured blocks), idempotently regenerated when the claims change. Behind the
agent seam (ORCH-21), with a **deterministic fallback** (Compose-unavailable → the page is the
structured blocks alone — today's behavior — never a hard failure). Works on `staging`, promotes via
the gate (CANON). Bounded + audited like every stage.

## 5. Requirements

| ID | Priority | Statement (short) | Verify | Traces |
| -- | -------- | ----------------- | ------ | ------ |
| COMPOSE-1 | must | Entity pages carry a **human-readable prose body** — an intro/lede + **section headers** + the entity's substance in flowing prose — *not* a bare links+claims dump. Reads encyclopedically in Obsidian | test: composeDoc.test.ts (renderProse lede + `##` sections) + composeStage.test.ts (composeOne writes the prose body) | PRIN-13; VAULT; VISION |
| COMPOSE-2 | must | **Inline citations + References:** prose statements carry inline `[n]`/`[^n]` markers; a **References** section maps each to its **source (human title, never a ULID)**, de-duplicated. Mirrors the cited-query style (SPEC-0026 ASK) | test: composeDoc.test.ts (source-level `[^n]` dedup + References by title) + composeStage.test.ts (titled, navigable References) | PRIN-2,10; ASK-7; PRIN-24 |
| COMPOSE-3 | must | **Grounded — synthesis, not generation:** the prose is composed **only from the entity's existing cited claims** (SPEC-0016); Compose **may not introduce a fact that isn't a claim**; every prose sentence **traces to a claim → a source**; an un-cited prose statement is a **defect**; **no new egress** | test: every prose sentence resolves to a claim/source — compose.test.ts (`validateGrounding`/`parseComposeDecision` REJECT an un-cited or out-of-range sentence) + composeAgent.test.ts (rejected through the real decider parse path) | PRIN-1,2,9,10; CLAIMS |
| COMPOSE-4 | must | **Links woven into the prose** — entity cross-links (`[[Other Entity]]`) appear **in the prose where they're mentioned**, not only as a block at the top; the page reads as connected text | test: composeStage.test.ts (`linkedEntityNames` feeds the agent; woven `[[Apple]]` renders in the prose) | CONNECT-12; VAULT |
| COMPOSE-5 | must | **Keep the structured blocks for RAG** — the delimited `kb:links` / `kb:claims` blocks remain (**below** the prose) so the machine/retrieval layer is intact; the prose is the human layer, the blocks the index. Both regenerate idempotently | test: composeDoc.test.ts (`applyProse` keeps the kb:links/kb:claims blocks below, idempotent + whole-regenerate) + composeStage.test.ts (claims block preserved) | DATA; ASK; CONNECT-12; CLAIMS-9 |
| COMPOSE-6 | must | **Human Title-Case filenames** (honor CANON-6 + PRIN-24): entity files are the **natural name** (`Steve Jobs.md`), spaces + real case — **not** a kebab-slug (`steve-jobs.md`); the ULID stays `id:` + alias (links survive renames). The kebab-slug `slugify` (connectDoc.ts) is the change point | test: connectDoc.test.ts (`entityFileName`/`entityFileRel`) + connectStage.test.ts (born-resolved node lands at `entities/<kind>/<Human Name>.md`) | CANON-6,7; PRIN-24; DATA-5 |
| COMPOSE-7 | must | A new **"Compose" Enrich stage** (after Claims) (re)writes the prose body from the entity's cited claims — **idempotent** (regenerated on claim change), behind the agent seam with a **deterministic fallback** (Compose-unavailable → structured blocks alone, never a hard failure); works on `staging`, promotes via the gate; bounded + audited | test: composeStage.test.ts (queue, idempotent no-op, re-queue on claim-change, blocks-only fallback, set-aside after K, stage drain + afterDrain promote) | ORCH-9,21; CANON-1,3; SPEC-0024 |
| COMPOSE-8 | should | **Sources surface a human title too** (PRIN-24 reach): a source's `source.md` carries a human title (derived if absent) so a `[[…]]` reference + the References section read as titles, never `sources/<shard>/<ULID>` | test: composeStage.test.ts (References resolve each source via `deriveSourceTitle` — titled, navigable, never a ULID label) | PRIN-24; VAULT; SPEC-0031 |
| COMPOSE-9 | must   | **Compose the WHOLE vault — backfill existing entities, don't leave most uncomposed.** Compose runs as a pipeline stage, so it only enriches entities **as they're (re)processed** — a one-time roll-out leaves a large existing backlog as bland block-only pages (live: only **~332 / 1032** entities composed). **Ship = every entity with cited claims gets its composed article.** A **backfill / recompose sweep** over `entities/` (a Reflect mode, REFLECT-16, or a one-shot re-poke) composes the existing corpus — **idempotent on the claims signature** (already-composed + unchanged → skip), **bounded + coalesced** so it doesn't storm promotion (STAGING-12). The done-bar is *"open any entity and it reads like an article,"* not a third of them. *(Principal: "entities should be like articles… flesh out and **ship**.")* | test:composeStage.test.ts, reflectJob.test.ts (a backfill pass composes a pre-existing uncomposed entity; re-running skips the unchanged ones) — none-yet | COMPOSE-7; REFLECT-16; STAGING-12; PRIN-5 |
| COMPOSE-10 | should | **Flesh out the article — depth proportional to the evidence.** Where an entity has rich claims, compose a **fuller, multi-section article** (overview/lede → thematic sections), not a one-paragraph stub; where claims are sparse, a **short but clean** page. Depth **scales with the grounded material available** — a major person/place reads like a real encyclopedia entry, a thin entity stays brief. Flesh-out is **more grounded prose**, never padding or speculation: every sentence still traces to a cited claim (COMPOSE-2). *(Principal: "you have details some but flesh out.")* | test:composeAgent.test.ts (a claim-rich entity yields multi-section prose; a sparse one stays short; both fully cited) — none-yet | COMPOSE-1,2,4; PRIN-2,4 |

## 6. User flow

- Open an entity in Obsidian → a **readable page**: a lede, sections, prose with inline citations,
  links to related entities woven in, References at the bottom — then the structured blocks.
- Hover/click a `[n]` → the source (by title). Click `[[Apple]]` → Apple's page (equally readable).
- The graph view shows **named** entities (Title-Case), connected — not ULID-slug dots.

## 7. Resolved decisions (Principal, 2026-06-08)

> **The outcome/requirements/spirit are the contract — the flow/steps are flexible.** Principal:
> *"we can tweak the specifics of the flow or steps at any time; it's the outcome, requirements,
> spirit stuff I want captured and working."* So **COMPOSE-1..6/8 (the outcome — readable, grounded,
> cited, human-named, links-woven, RAG-intact) are firm**; the **mechanism (COMPOSE-7: a separate
> Compose stage) is the chosen-but-adjustable means**, not the point. Implementers may re-shape the
> flow/steps freely as long as the §3 grounding invariant and the §5 outcome requirements hold.

- **Separate "Compose" stage → CONFIRMED** ("let's add a separate compose if that helps") — clean
  separation (Connect owns identity+links, Claims owns substance, Compose owns the *human
  presentation*; re-runs on claim change without disturbing them). But per the framing above, the
  stage boundary is a means to the outcome, not a hard requirement — adjustable.
- **Title-Case filenames (COMPOSE-6) → CONFIRMED** (it's the kebab half of PRIN-24). The `slugify`
  grep-convenience yields to the human name; the ULID stays the identity (filename is cosmetic), so
  spaces/case are safe — Obsidian handles them fine.

## 8. Out of scope

- **Inventing facts / pulling new sources** — that's Research (SPEC-0028); Compose is internal
  synthesis of existing cited claims only (§3).
- **Editing the prose by hand** — the body is generated (regenerated on claim change); Principal edits
  flow through the normal capture→claim path, not by editing the page (the structured blocks already
  say "edit via Connect/Claims, not here").
- **A full Wikipedia-grade article** (infoboxes, images) — v1 is grounded prose + sections + citations.

## 9. Changelog

- 2026-06-08 — created (draft), Principal greenlight ("entities like Wikipedia pages… not so ugly and
  bland… goes to the human-readable stuff"). A **Compose** Enrich stage that synthesizes the entity's
  **cited claims** into **grounded encyclopedic prose** (sections + inline citations + References +
  woven links), keeping the structured links/claims blocks below for RAG, with **Title-Case human
  filenames** (CANON-6 + PRIN-24). Grounding is the non-negotiable (COMPOSE-3): synthesis of cited
  evidence, never new facts, no egress. Two forks for the Principal in §7 (separate stage [lean];
  Title-Case filenames [lean yes]). Spec-first; impl + tests → PM. Ties the entity-pages ask to PRIN-24
  (the kebab-slug + ULID-surfacing is the same human-readable problem).
- 2026-06-08 — **Slice 1 (COMPOSE-6) implemented**: new entity files land at `entities/<kind>/<Human Name>.md`
  — the leaf is the natural name (real case + spaces preserved), the kind directory stays a lowercase slug
  (`entities/organization/Apple.md`). New `entityFileName()` (connectDoc.ts) strips only path/Obsidian-wikilink-
  illegal chars + control chars, keeps case/hyphens, collapses whitespace, drops leading/trailing dots, caps
  length, falls back to `Unnamed`; `entityFileRel` uses it for the leaf + a human collision suffix
  `<Human Name> (<id6>).md` (never a ULID-only filename, CANON-7). Existing entities keep their stored `rel`
  (ULID identity persists → no mass-rename); only new files get the human name. COMPOSE-7 (the Compose stage)
  + the prose/citations/grounding/woven-links layer (COMPOSE-1..5,8) follow as Slice 2.
- 2026-06-08 — **Slice 2 (COMPOSE-1..5,7,8) implemented**: the **Compose Enrich stage** (after Claims).
  It (re)writes each entity node's encyclopedic **prose body** from that entity's **cited claims** —
  a lede + `##` sections in flowing prose (COMPOSE-1), inline source-level `[^n]` citations → a
  **References** section of cited sources by **human title** (`deriveSourceTitle`, never a ULID —
  COMPOSE-2/8), entity cross-links woven into the prose (COMPOSE-4) — while keeping the structured
  `kb:links`/`kb:claims` blocks **below**, untouched (COMPOSE-5). **Grounding (COMPOSE-3)** is enforced
  structurally: the agent returns sentences each tagged with the claim number(s) it draws on, and the
  parse seam REJECTS an un-cited or out-of-range sentence, so un-grounded prose can never be written;
  the renderer (not the agent) emits the `[^n]` markers so every citation traces to a real source.
  The stage (COMPOSE-7) is **idempotent on the claims signature** (recomposing identical claims is a
  no-op; a claim change re-composes), behind the ORCH-21 agent seam with a **deterministic blocks-only
  fallback** (agent unavailable/errors/un-grounded → record the attempt, leave today's blocks-only
  node, set aside after K — never a hard failure, NO egress), bounded + audited (actor `compose`).
  New: compose.ts (types + grounding validator), composeDoc.ts (render + idempotent prose-region
  surgery), composeAgent.ts (compose/v1 seam), composeStage.ts (stage + queue + fallback); wired after
  Claims in pipeline.ts (Claims/Connect poke it; its afterDrain promotes to main). Deferred: a Compose
  **station on The Line** (Status UI) — a small net-new-visual fast-follow (Design-Lead gate), the
  stage already runs + promotes + audits headlessly.
