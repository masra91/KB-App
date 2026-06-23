---
spec: SPEC-0050
key: DIR
title: Directives (durable human interpretation — corrections, merge/distinct, guidance)
type: feature
status: draft
owners: [KB-Developer-7, KB-Lead, Principal]
created: 2026-06-15
updated: 2026-06-15
related: [SPEC-0002, SPEC-0007, SPEC-0016, SPEC-0018, SPEC-0019, SPEC-0020, SPEC-0022, SPEC-0024, SPEC-0028, SPEC-0047, SPEC-0051]
stage: cross-cutting
supersedes: null
---

# Directives

> A **directive** is durable, human-given **interpretation** — a standing instruction the Principal
> gives the system ("these two are the same org", "this claim is wrong", "keep enriching her toward
> her publications"). It is a **first-class artifact, distinct from a source**: a source is *evidence*
> (decomposed into candidates/claims); a directive is *not decomposed* — it **nudges a downstream
> decision** rather than adding ground truth. The defining property: a directive is keyed on a **STABLE,
> content-derived identity** (a block identity `kind|normalizedName`, or a pair of them), so it **survives
> the ULID rebirth** that a re-derive / Full Replay inflicts on entities — unlike the working-zone
> decision logs, which go blind the moment their ULIDs are reborn.

## 1. Intent (the why)

The Principal kept hitting the same wall: *"I keep answering the same review — is Disney one org? — over
and over, and after a rebuild it's back."* The cause is a **memory-keying bug**. A settled answer was
remembered only against the **entity ULIDs** in play at answer-time (`connect/disambiguation.jsonl`,
`disambiguationDecisions.ts`). Those ULIDs are **purged + reborn** on every re-derive and every Full
Replay (`entities/` is in `PURGE_DIRS`), so the settled verdict never re-matched the freshly-minted
ULIDs and the identical review re-raised — on every new same-name source AND after every replay.

The fix is to **graduate** a human answer to a **directive** keyed on the **block identity** — which is
content-derived (`kind|normalizeName(name)`, e.g. `organization|disney`) and therefore **stable across
rebirth**. Directives live under an **evergreen** `directives/` tree: promoted to `main` (SPEC-0019) and
**absent from replay's `PURGE_DIRS`** (SPEC-0022), so they persist through reset/replay and remain the
published truth.

This generalizes beyond disambiguation. Anywhere the Principal corrects or steers the machine, that
intent should be **durable** and **rebirth-proof** — corrections to claims, ad-hoc merge/distinct rulings
on separate entities, freeform guidance, enrichment steers, and the ability to revoke any of them.

## 2. The directive model

All directives share: a `type` discriminator, a **stable identity key** (single block identity, or an
order-independent **pair** of block identities), a `verdict`/payload, `reviewId` provenance (PRIN-5/6),
and `decidedAt` (ISO; **last-wins** on revision — a later opposite verdict supersedes). Storage is an
append-only JSONL per family under `directives/`, **garbled-line tolerant** (ENG-16: one bad append never
blinds the store). Records are written under the **shared canonical-writer lock** by the path that
produces them (so the directive lands in the **same commit** as the answer/correction) and promoted to
`main` by the promotion gate.

| Type | Key | Meaning | Consumer | Slice |
|---|---|---|---|---|
| **disambiguation** | single block identity | within-block "these same-name mentions are one entity" (`same`) / per-pair `distinct` | Connect (`connectStage`) | 1 ✅ |
| **merge** / **distinct** (consolidation) | **pair** of block identities | ad-hoc "these two SEPARATE entities are / are not the same" | Reflect (`reflectJob`), SPEC-0051 orphan-linker | 2a ✅ |
| **reattribute** | block identity + claim ref | "this claim belongs to entity B, not A" | Claims / Compose read path | 2b ▢ |
| **retract** | block identity + claim ref | "this claim is wrong — suppress it" | Claims / Compose read path | 2b ▢ |
| **guidance** | block identity (or global) | freeform durable steer for an entity | relevant stage prompt | 2c ▢ |
| **enrich** | block identity | "keep enriching X toward Y" (ties to RESEARCH-24 gap, SPEC-0028) | Research orient (`enrichGap`) | 2c ▢ |
| **revoke** | target directive id | cancels a prior directive | the directive reader (active-set) | 2c ▢ |

### 2.1 Stable keys

- **`blockKey(kind, name)`** = `kind|normalizeName(name)` (SPEC-0020 §3.2) — the single-identity key.
- **`directivePairKey(a, b)`** = order-independent sorted join (`a::b`) of two block identities. The `::`
  separator never occurs inside a block identity (`normalizeName` strips punctuation to spaces), so the
  key is unambiguous and **content-derived** — identical before and after a re-derive. This is the
  **shared primitive** the SPEC-0051 orphan-linker consults (it must never link a settled-`distinct`
  pair); one pair-key, two callers.

## 3. Durability + replay survival (acceptance)

Every directive type MUST:

1. be keyed on a **stable block identity** (or pair) — **never** an entity ULID;
2. live under the evergreen `directives/` tree (promoted to `main`, never in `PURGE_DIRS`);
3. **survive a Full Replay** — proven by a test that records a directive, runs the replay, and asserts it
   is intact **on staging AND republished on `main`**;
4. carry a **rebirth regression** test where the ULID-keyed log is provably blind (ULIDs reborn) yet the
   directive still settles the question — with a **control** proving the bug exists without it.

## 4. Surfacing — the Rules surface (slice 3 ▢)

A read-only in-app **"Rules"** view lists the **active** directives (revokes applied) — the Principal's
standing interpretations — with type, the human-readable identity (**never a raw ULID**, PRIN-24),
verdict/payload, and provenance (which answer/correction produced it, when). An inline **"correct this"**
affordance on an entity/claim creates the right directive type directly (e.g. retract a claim, mark two
entities distinct) without waiting for the machine to raise a review. Carries the **Design-Lead visual
gate** in addition to QD-2.

## 5. Implementation status

- **Slice 1 (DIR-2/3/4/8) — ✅ #356.** Durable **disambiguation** directive (Connect), evergreen +
  replay-survival. `directives.ts` storage; recorded in `reviewStore.answerReview`; consumed in
  `connectStage`. Merge (`same`) auto-resolves a block; `distinct` stays per-pair.
- **Slice 2a (ad-hoc merge/distinct) — ✅ this PR.** Pair-keyed **consolidation** directive +
  `directivePairKey`/`consolidationDirectiveForPair`. Producer: `answerReview` on a consolidation review
  (confirm→merge, reject→distinct). Consumer: `reflectJob.filterStatefulFindings` (survives rebirth where
  the ULID decision goes blind) + the SPEC-0051 orphan-linker's `blocked` seam.
- **Slice 2b (corrections: reattribute/retract) — ▢ next.**
- **Slice 2c (guidance/enrich/revoke) — ▢.** `enrich` folds into RESEARCH-24's gap payload (DEV-2).
- **Slice 3 (Rules surface + "correct this") — ▢.** QD-2 + Design-Lead visual.

## 6. Non-goals

- A directive is **not** evidence — it is never decomposed into candidates/claims and never counts as a
  source citation. It only nudges a decision.
- Directives do **not** rewrite entity content directly; they steer the stage that does (faithful to the
  "interpretation, not ground truth" boundary).
- A **same-identity** pair (two nodes sharing one block identity) cannot be told apart by a content-derived
  key after rebirth, so ad-hoc merge/distinct on such a pair falls back to the per-pair ULID decision;
  durable cross-rebirth treatment of that case rides the SPEC-0047 confidence line (future).
