---
spec: SPEC-0031
key: VAULT
title: Obsidian Vault Representation (the human view)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0003, SPEC-0007, SPEC-0016, SPEC-0020, SPEC-0021, SPEC-0025, SPEC-0017]
stage: Cross-cutting
supersedes: null
---

# Obsidian Vault Representation (the human view)

> The pipeline produces *correct data*; **VAULT makes it a *good vault*** — a clean graph,
> readable entity pages, sane naming, and **shipped Obsidian config** (graph filters, tag
> colors, Bases) — so browsing, the graph, search, and dashboards are good **out of the box**,
> in **core Obsidian with no required plugins**. The vault **is** the system of record
> (VISION-12); Obsidian is an **optional viewer**. Motivated by: the graph is ugly — claim and
> source files show up as **ULID nodes** drowning the entities.

## 1. Intent (the why / JTBD)

The KB is native markdown (VISION-12), and the human reads/explores it **in Obsidian** — graph
view, file explorer, search, Bases. Today the *data* is right (entities are human-named,
deduped, tagged) but the *vault* is noisy: every **claim** (`claims/<ULID>.md`) and **source**
(`sources/<ULID>/…`) becomes a graph node, so ~80 ULID nodes bury 32 real entities. JTBD:
*"when I open my KB in Obsidian, it should look like connected knowledge — clean graph of named
things, readable pages, useful views — not a wall of ULIDs."*

## 2. Principles

- **Vault is system-of-record**, plain markdown + folders; must **degrade gracefully** in any
  editor/file browser without Obsidian.
- **Good in core Obsidian** — no required third-party plugins (Properties, Tags, Bases, Graph
  are core).
- **The app maintains `.obsidian/` config** but **never clobbers** the Principal's manual edits
  (write-once / merge-respecting, like clubhouse-mode's "never overwrite once it exists").

## 3. The graph model — what is a node

| Artifact | Graph node? | Where the human sees it |
| --- | --- | --- |
| **Entity** | ✅ **first-class** (human-named, **tag-colored**) | a node; linked **entity ⇄ entity** via Connect's relationship `[[wikilinks]]` |
| **Claim** | ❌ **excluded** | **embedded, readable, in the entity note** (cited); the `claims/<ULID>.md` file is structured **provenance**, graph-hidden |
| **Source** | ❌ **excluded** | provenance (`derivedFrom`); **browsable** in the file tree, but not a graph node |
| **Output** | ◐ optional | synthesis; may appear, tagged as output |

The graph should read as **named things connected to named things, colored by topic/type** —
claims and sources are *substance and provenance*, not navigation targets.

## 4. The entity page (the human-readable unit)

A human opens an **entity note** and sees everything they need **without opening claim/source
files**:
- **Identity** — name, kind, tags, aliases.
- **Knowledge** — a **readable claims section**: each claim in prose with its **source
  citation** (e.g. *"Owns the Q3 budget — [src](…), interpretation, 0.7"*). This is the
  entity's "what and why."
- **Related entities** — the `[[wikilinks]]` Connect promoted (these *are* graph edges).
- **Provenance** — `derivedFrom` sources, transform trail.

> **Gap found in testing:** today the entity body is **only the raw claims block** (a list of
> `- [[ULID]] — statement`) — **no curation, no summary, no prose.** It reads like a database
> dump. Two missing pieces: (a) **readable rendering** of claims (VAULT-3), and (b) a **curated
> entity summary** — a synthesis paragraph — which is a **new capability** (no step writes it
> today). See VAULT-11 + §10.

## 5. Claims representation (the crux — pending Principal confirm)

**Recommended (v1):** claims stay **structured provenance files** (keeps Recall queryability,
per-claim source provenance, replay granularity, Connect/Reflect dedup) **but are graph-excluded
and never surfaced as standalone ULID nodes**; their **readable content is embedded in the entity
note** (§4). The human reads the entity; the files back it.

*Alternative (open):* fold claims **entirely into the entity note** (no separate files) — simpler
vault, but loses structured per-claim provenance + the granular Recall/Reflect handles. Pinned as
an open question — the Principal is evaluating live (what drops out when `claims/`/`sources/` are
filtered).

## 6. Shipped Obsidian config

The app writes/maintains `<vault>/.obsidian/`:
- **Graph filters** — exclude `claims/`, `sources/`, `raw` from the graph (`-path:…`).
- **Color groups by `tag`** — `tag:#type/person`, `tag:#topic/…` → node colors (SPEC-0025).
- **Bases dashboards** (the deferred SPEC-0025 follow-up) — starter views by type/topic/recent.
- Written **non-destructively** (respect existing/edited config).

## 7. Requirements

| ID       | Priority | Statement (short)                                                                  | Verify   | Traces |
| -------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| VAULT-1  | must     | The vault is native-markdown **system-of-record**, good in **core Obsidian** (no required plugins), and **degrades gracefully** without Obsidian | none-yet | VISION-12; PRIN-5 |
| VAULT-2  | must     | **Only entities are graph nodes** (human-named, **tag-colored**, linked entity⇄entity); **claims and sources are excluded** from the graph | none-yet | CONNECT-3; LIFE-5 |
| VAULT-3  | must     | The **entity note is the human-readable page** — identity + a **readable claims section** (each claim in prose **with its source citation**) + related-entity `[[wikilinks]]` + provenance — readable **without opening claim/source files** | none-yet | CLAIMS; ASK-7; PRIN-2 |
| VAULT-4  | must     | Claims remain **structured provenance files** but are **graph-hidden / not standalone nodes**; ULIDs never clutter the human view *(pending the §5 fold-in decision)* | none-yet | CLAIMS; DATA-10 |
| VAULT-5  | must     | The app **ships + maintains `.obsidian/` config**: graph filters excluding `claims/`/`sources/`/`raw`, and **color groups by `tag`** | none-yet | META-1,3; VISION-12 |
| VAULT-6  | must     | Config is written **non-destructively** — the app respects/merges the Principal's manual Obsidian edits and never clobbers them | none-yet | PRIN-5 |
| VAULT-7  | should   | Ship **starter Bases dashboards** (by type/topic/recent) over the metadata (SPEC-0025) — the deferred views follow-up | none-yet | META; LIFE-5 |
| VAULT-8  | must     | **Naming**: entities are human-named files (Connect); claims/sources keep ULID provenance names but are graph-hidden, so ULIDs never appear in the human view | none-yet | CONNECT-3 |
| VAULT-9  | should   | Folder layout is **browsable/legible** in the Obsidian file explorer (entities grouped, sources date-sharded, claims/outputs as provenance/synthesis) | none-yet | DATA-9 |
| VAULT-10 | should   | The representation is **Replay-stable** — a clean/rebuild regenerates the same human view + config | none-yet | REPLAY-14 |
| VAULT-11 | should   | The entity page is **readable, not a raw list** — claims rendered in prose/grouped + cited; and a **curated entity summary** (synthesis paragraph) tops the page. *(The summary is a new synthesis step — owner TBD: Connect/Claims enhancement vs. a Reflect/Recall job.)* | none-yet | VISION-9; CLAIMS; LIFE-8 |
| VAULT-12 | should   | Entity↔entity links render with **display names** via the Obsidian alias form `[[path\|Name]]` — resolves by path (collision-safe), shows the **entity name**, not the raw path | test:connectDoc.test.ts, connectStage.test.ts | CONNECT-12,13; [#91](https://github.com/masra91/KB-App/issues/91) |
| VAULT-13 | should   | A claim's **source is a navigable link** (`[[sources/…\|<date>]]`) in the claim + the entity's claims block, so a human can **click through to the source** — not just provenance metadata | test:claimDoc.test.ts, claimsStage.test.ts | CLAIMS; ASK-7; [#92](https://github.com/masra91/KB-App/issues/92) |

## 8. User flows / surface

- Open the vault in Obsidian → **graph of named, tag-colored entities** (no ULIDs).
- Click an entity → its **readable page** (claims with citations + related entities) — no need to
  open claim files.
- Open a shipped **Base** → filter entities by type/topic.

## 9. Out of scope (for now)

- **Interactive editing of the KB *through* Obsidian** — Obsidian is a viewer; edits flow through
  capture/Review, not hand-editing derived notes. (A separate, larger question.)
- **Requiring Obsidian** — it stays optional; the app never depends on it running.
- **Custom Obsidian themes/CSS** beyond graph/Bases config.

## 10. Open questions

- [ ] **Claims: separate files vs. folded into the entity** (§5) — the central decision; Principal
      evaluating live.
- [ ] **Where claim provenance lives if folded** — inline per-claim citation vs. a provenance
      sidecar.
- [ ] **`.obsidian/` ownership** — how aggressively the app manages config vs. just seeds it once
      (non-clobber, VAULT-6).
- [ ] **Sources in the graph** — fully hidden vs. a single collapsed "source" node per entity.
- [ ] **Folder grouping** — entities by `kind`, by `topic/`, or flat (Connect already shards;
      confirm the human-browsable layout).
- [ ] **Curated entity summary** (VAULT-11) — who writes the synthesis paragraph? A
      Connect/Claims enhancement, a Reflect job, or recall-time only? And is it stored on the
      node (evergreen) or generated on demand? *(Found in testing: entity pages are currently a
      bare claims list with no prose/curation.)*
- [ ] **Link-promotion not triggering** — separate from VAULT, but observed alongside: claims
      carry `relatesTo` hints yet Connect's link pass (CONNECT-12/13) isn't re-poked after Claims,
      so **zero entity↔entity links** are made on a rebuild. (Filed as a pipeline bug.)

## 11. Changelog

- 2026-06-02 — **VAULT-13 residual closed (#92 follow-up).** The merge- and dedup-regenerated claims
  blocks now also carry the navigable source citation: `mergeNodes` and `claimDedup` thread the
  claim's `derivedFrom` into `ClaimBacklink.source`, so a claim's click-through survives a node merge
  or a within-source dedup — VAULT-13 is now consistent across all three block-regen paths
  (Claims-stage, merge, dedup), not just the Claims-stage path. Also fixed `mergeNodes`'s own
  `parseClaim` to take `statement = first body line` (the **third** claim-body parser; #116 fixed the
  other two — this one was latently affected by the same VAULT-13 `Source:` trailer, surfacing only on
  merge-regeneration). Tests: mergeNodes.test.ts (clean statement + citation on the regenerated row),
  claimDedup.test.ts (citation on the dedup-regenerated row).
- 2026-06-02 — **VAULT-12 (entity-link display names)** implemented (#91). Connect's
  link-promotion now renders entity↔entity links as the Obsidian alias form `[[path|Name]]`
  (`connectDoc.ts` `renderLinksBlock` + an optional `name` on `NodeLink`; `linkOne` passes the
  target's name from its `nameByRel` index). Resolves by path (collision-safe) but shows the entity
  name, not the raw ULID/path — the graph reads as named things. Back-compat: a name-less link still
  renders bare. Graduated VAULT-12 `none-yet → test:` (connectDoc.test.ts, connectStage.test.ts).
- 2026-06-02 — **VAULT-13 (clickable claim→source)** implemented (#92). A claim's source is now a
  navigable Obsidian link `[[<sourceDir>/source.md|<date>]]` (display = the capture date parsed
  from the date-sharded path — deterministic, no I/O, Replay-stable per VAULT-10) rendered both in
  the **claim file body** and in each row of the **entity's claims block** (`claimDoc.ts`
  `sourceLink` + an optional `source` on `ClaimBacklink`; wired in `claimsStage`). The block path
  is delivered for **Claims-stage**-regenerated blocks; the **merge- and dedup-regenerated** block
  paths (`mergeNodes`/Connect + `claimDedup`) pass the source field as part of the **connectStage
  seam PR (#91/VAULT-12)** — kept out of this PR so #92 stays off the in-flight seam. Graduated
  VAULT-13 `none-yet → test:` (claimDoc.test.ts, claimsStage.test.ts).
- 2026-06-02 — created (draft). The **human/Obsidian representation** layer: the pipeline makes
  correct data, VAULT makes a **good vault** — **graph = entities only** (tag-colored;
  claims/sources excluded), the **entity note as the readable page** (claims embedded + cited),
  **shipped non-destructive `.obsidian/` config** (graph filters + tag colors + starter Bases),
  human naming (ULIDs hidden), Replay-stable. Core Obsidian, no required plugins; Obsidian stays
  optional. Motivated by a live graph that was a wall of ULID claim/source nodes. **Central open
  question: do claims stay separate provenance files (recommended) or fold into the entity note**
  — the Principal is evaluating by filtering `claims/`/`sources/` out of the graph.
