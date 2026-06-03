---
title: Knowledge-Health & Maintenance — Capability Analysis
type: research
status: draft
owners: [KB-Lead]
created: 2026-06-03
related: [SPEC-0016, SPEC-0018, SPEC-0020, SPEC-0024, SPEC-0029, SPEC-0031]
---

# Knowledge-Health & Maintenance — Capability Analysis

> A survey of the **knowledge-health / self-maintenance** capability space for an LLM-built
> markdown wiki, our current position against it, and the capabilities worth lifting. Focus:
> **structural linting, contradiction handling, dedup/merge hygiene** — the layer that keeps a
> generated wiki *clean and trustworthy over time*, not just *built once*. (Model-provider
> breadth and offline/local inference are deliberately out of scope here.)

## 0. Why this matters

A wiki that an agent *writes* degrades the same way a hand-kept one does — faster, because
volume is higher: dead links pile up, near-duplicate nodes fork, stub pages linger, and newer
sources quietly contradict older claims. Our autonomy makes this **more** acute, not less: the
machine produces structure continuously, so the *maintenance* loop has to be at least as good
as the *production* loop or the vault rots. This analysis treats "knowledge health" as a
first-class capability area and asks, bluntly, where we're behind a well-built maintenance layer.

## 1. The capability map (what a strong health layer provides)

A mature self-maintaining wiki tends to provide **five** capability clusters:

1. **Structural lint** — cheap, mostly *deterministic* checks over the vault's link/file graph:
   broken `[[links]]` (dead links), **orphans** (nodes with no in/out links), **empty/stub**
   pages, **malformed links** (e.g. double-nested `[[[[…]]]]`), **path-polluted filenames**
   (folder prefixes leaking into names), **missing aliases**.
2. **Contradiction lifecycle** — detect when sources assert conflicting facts, and track each
   conflict through an explicit **state machine** to resolution (not just "record both and hope").
3. **Dedup & merge hygiene** — find duplicate/near-duplicate nodes (incl. cross-language and
   acronym variants) and **fuse** them without losing content, provenance, or genuine disagreement.
4. **Repair orchestration** — run the fixes in **dependency order** so an early fix doesn't
   manufacture a later violation; cheap deterministic fixes before expensive judgment ones.
5. **Maintenance triggers** — when the sweep runs: scheduled, on-idle, on-change, on-startup —
   all opt-in, all bounded.

## 2. Our position, cluster by cluster

| Capability | Our coverage today | Gap / opportunity |
| --- | --- | --- |
| **Structural lint (deterministic)** — dead links, orphans, empty/stub, malformed links, polluted filenames | **Partial / implicit.** REFLECT (SPEC-0024) detects "missing/lost connections" by *agent judgment*; promotion + Connect keep links mostly valid. But we have **no cheap, deterministic structural-lint pass** that mechanically finds & fixes dead links / orphans / stubs / malformed links **without spending an LLM call**. | **Lift.** A deterministic vault-graph linter is high-value, near-zero-cost, and runs constantly. Most of these are fixable with **no model call** (the expensive part is only *content* repair). |
| **Aliases (first-class)** — every node carries ≥1 alias (acronym, translation, alt-name) | **Missing.** Entities have id/kind/name/provenance; **no alias field**. Connect dedup leans on name + agent judgment. | **Lift (enabler).** Mandatory aliases (a) make dedup cheap and reliable (acronyms, cross-language, variants become *direct* matches, not judgment calls), and (b) improve Obsidian UX (searchable alternates). Powers cluster 3. |
| **Contradiction lifecycle** | **Raw material only.** Claims carry per-claim `status`/`confidence` and we record *both* conflicting claims (CLAIMS-17); SPEC-0016 explicitly defers "conflict surfacing" to "a Connect/Review concern." **No detection, no tracking, no state machine.** | **Lift (biggest gap of interest).** Add an explicit **contradiction object** with a lifecycle (see §3) flowing through the Review queue. We already have the substrate (per-claim epistemics + Review); we're missing the layer that *uses* it. |
| **Dedup & merge / fusion** | **Have (judgment-based).** Connect (SPEC-0020) clusters & merges entities, repoints claims; CLAIMS-19 collapses within-source claim near-dupes; possible-duplicate signals exist. | **Refine.** Add a **cheap-first tier** (alias/name exact + structural signals → no LLM) ahead of the agent-judged tier; add a **"protected" flag** so human-edited nodes are exempt from agent overwrite during fusion (we route destructive ops to Review but don't protect *human edits* on otherwise-additive updates). |
| **Repair orchestration (causality order)** | **Missing.** REFLECT applies findings, but there's no **ordered repair sequence**. | **Lift (cheap).** A fixed dependency order prevents fix-thrash (e.g. *normalize filenames → complete aliases → dedup/merge → fix dead links → adopt orphans → expand stubs*); each stage settles before the next so earlier fixes don't spawn new violations. |
| **Maintenance triggers** | **Have.** REFLECT runs as a bounded, scheduled, single-flight **Job** (SPEC-0023/0024), guarded posture, audited. | **Mostly covered.** Optionally add **on-change** and **on-idle** triggers (opt-in, default off) alongside the scheduled sweep. |

## 3. The two we most want to lift

### 3.1 Deterministic structural lint (cheap, constant, no-LLM)

A standalone **vault-graph linter** that runs over the markdown link/file graph and reports +
auto-fixes a fixed catalog of **structural** issues without model calls:

| Issue | Detection (deterministic) | Auto-fix |
| --- | --- | --- |
| Dead link | `[[target]]` resolves to no node | repoint to a known alias, else flag |
| Orphan | node with 0 in **and** 0 out links | queue for adoption (judgment step) |
| Empty / stub | node body under a content threshold | queue for expansion (judgment step) |
| Malformed link | `[[[[…]]]]`, nested/escaped wikilinks | rewrite to canonical form |
| Path-polluted name | folder prefix leaked into filename/title | rename + repoint refs |
| Missing alias | node with no `aliases` | queue alias-completion (judgment step) |

The discipline worth copying: **separate the deterministic detection (free, always-on) from the
content repair (LLM, queued).** Most lint is structural and costs nothing; only *adoption /
expansion / alias-completion* need a model. This is a natural **REFLECT sub-capability** (or a
small dedicated health job) and folds its findings into the existing audit + Review surfaces.

### 3.2 Contradiction lifecycle (a state machine over our claims)

We already record conflicting claims with epistemic metadata; what's missing is treating a
**contradiction as a first-class tracked object** with an explicit lifecycle:

```
            ┌─────────── agent confirms a resolution (newer/stronger source supersedes)
            ▼
detected ──► resolved
   │
   ├──► accepted   (both views legitimately stand — e.g. historical disagreement; kept, attributed)
   │
   └──► needs-you  (genuine conflict the machine won't auto-resolve → Review queue)
```

- **Detected**: two claims about the same entity assert incompatible facts (agent-judged over a
  bounded set, like REFLECT's other detections — no embeddings).
- **Resolved**: a newer/stronger-provenance claim supersedes; the superseded claim is retained
  but marked (we never destroy source-grounded testimony).
- **Accepted**: both stand with attribution (the "both are true per their source" case).
- **Needs-you**: routed to the **Review queue** (SPEC-0018) — this is the unified "needs your
  decision" surface (#192) doing exactly the job it's designed for.

This rides entirely on substrate we already have: per-claim `status`/`confidence`/provenance
(SPEC-0016), the Review queue (SPEC-0018), deletion-aware promotion (SPEC-0019/0021), and the
audit log (SPEC-0029). It's a **lifecycle on top**, not new infrastructure — and it directly
strengthens grounding (recall can show "this is contested," not just assert).

## 4. What we should NOT lift (and what we already do better)

- **All-LLM maintenance** — relying on a model for *structural* checks is wasteful; our edge is
  to make the cheap stuff deterministic and reserve judgment for content.
- **Manual, user-triggered upkeep** — our maintenance is an **autonomous Job** (REFLECT) with a
  guarded auto/Review split; we should keep that and *not* regress to "user clicks Lint."
- **Page-level health only** — our **per-claim** epistemics + **git-backed audit/lineage/replay**
  are a stronger substrate for contradiction & provenance than page-frontmatter tracking; lift the
  *lifecycle idea*, keep our deeper model underneath it.

## 5. Recommended next steps (for the spec set)

1. **REFLECT (SPEC-0024):** add a **deterministic structural-lint sub-capability** (§3.1) — the
   free, always-on graph checks, with content repairs queued as existing REFLECT findings.
2. **CLAIMS/REVIEW (SPEC-0016 + SPEC-0018):** add the **contradiction lifecycle** (§3.2) as a
   first-class tracked object flowing into the unified needs-you queue (#192).
3. **Data model (SPEC-0007/0031):** add **first-class `aliases`** on entities (enabler for cheap
   dedup + Obsidian UX), and a **`protected`/human-edited** flag exempting a node from agent
   overwrite during additive fusion.
4. **CONNECT (SPEC-0020):** add a **cheap-first dedup tier** (alias/name/structural signals → no
   LLM) ahead of the agent-judged tier.
5. **Repair ordering:** pin a **causality-ordered repair sequence** wherever these fixes apply.
