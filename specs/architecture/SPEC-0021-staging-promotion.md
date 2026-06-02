---
spec: SPEC-0021
key: STAGING
title: Staging Branch & Promotion Gate
type: architecture
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-31
updated: 2026-06-02
related: [SPEC-0007, SPEC-0013, SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0018, SPEC-0019]
supersedes: null
stage: Cross-cutting (the engine that realizes SPEC-0019)
---

# Staging Branch & Promotion Gate

> The implementing mechanism for SPEC-0019's evergreen invariant: a vault has two long-lived
> branches — **`staging`** (where every librarian works) and **`main`** (the evergreen
> published view) — and a **promotion gate** that advances `main` to hold only the evergreen
> subset of `staging`. Stages no longer write `main`; they write `staging`, and the gate
> publishes.

## 1. Intent (the why / JTBD)

SPEC-0019 (CANON) makes the rule — `main` is evergreen; pre-resolution / working state is
hidden on `staging`. This spec is the **engine change** that makes it real, extending the
SPEC-0014 orchestration pattern. It is intentionally **thin**: it pins the branch topology,
the promotion mechanism, and the evergreen↔working path split — the operational decisions
SPEC-0019 deferred — and nothing about *resolution* (that is SPEC-0020 CONNECT).

Without it, "evergreen `main`" is only prose; with it, a working stage **structurally cannot**
pollute `main`, because it never writes there.

## 2. Branch topology

A vault repo carries two long-lived branches:

| Branch | Role | Who writes it |
| ------ | ---- | ------------- |
| **`staging`** | the working surface — **every** stage (archivist, Decompose, Connect, Claims, Research) reads + advances it; holds evergreen *and* working artifacts | the stages, via their worktrees |
| **`main`** | the evergreen published view — what Obsidian, `grep`, Query, and the Principal see | **only the promotion gate** |

- `staging` is created at KB setup (branched from `main`) and is the default branch the
  orchestration engine advances.
- Worktrees are unchanged (per-run isolation, SPEC-0014); each stage's worktree now syncs to
  **`staging`** and `merge --ff-only`s into `staging` (instead of `main`). This is a
  one-line retarget of the existing pattern (`reset --hard staging`; `merge --ff-only` on
  `staging`).
- No stage ever targets `main`. CANON-8 becomes structural.

## 3. Evergreen vs. working paths

`main` ⊆ `staging`: `main` holds exactly the **evergreen path set**; `staging` additionally
holds the **working path set**, which is never promoted.

| | Paths | On `staging` | On `main` |
| --- | --- | --- | --- |
| **Evergreen** | `sources/`, `entities/`, `claims/`, `outputs/` | yes | **yes** (promoted) |
| **Working** | `inbox/` (pre-archive), `candidates/` (Decompose output), `queue/`, `reviews/`, `.kb/…` | yes | **no** |

- A **source** is evergreen the moment it is archived (immutable ground truth, DATA-2) → it
  promotes immediately.
- A **candidate** (Decompose output) is working → it stays on `staging` only (STAGING-5). Shape
  (pinned in slice 2): **one JSON file per candidate** at `candidates/<dateShard(id)>/<id>.json`,
  carrying SPEC-0020's `Candidate` contract (`id`, `sourceId`, `kind`, `name`, `confidence`,
  `mentions`) — Decompose is the writer, CONNECT the reader.
- An **entity** is evergreen only once **resolved** (SPEC-0020 CONNECT writes `entities/`);
  until then `entities/` is empty on both branches (CANON-10).
- **`reviews/` and `inbox/` are working** — so the app must read them from **`staging`**, not
  `main` (see §5 / STAGING-7); only Obsidian-facing evergreen knowledge reads from `main`.

## 4. The promotion gate

Promotion is **copy-the-evergreen-paths** (chosen for simplicity + git-native behavior):

```
promote(staging → main), under the shared canonical-writer lock:
  in a main-targeted worktree (or the root):
    for each path P in EVERGREEN_PATHS:
      # make main's P an EXACT MIRROR of staging's P — adds, edits, AND deletions
      git rm -r --cached --ignore-unmatch -- P   # forget main's current P (so removals propagate)
      git checkout staging -- P                  # re-materialize P from staging
      git add -A -- P                            # stage the net adds + deletions
    if the index changed:
      git commit -m "promote: <summary>"   # main advances; working paths were never touched
```

- **Serialized** through the same `stageLock` Mutex as every canonical advance (SPEC-0014 §5)
  — promotion and stage ff-advances never race.
- **Idempotent:** if no evergreen path changed since the last promotion, it is a no-op.
- **Deletion-aware (mirror, not append):** each promote makes every evergreen path on `main`
  an **exact mirror** of `staging` — additions, modifications, **and removals**. Connect's
  dedupe **deletes** merged-away loser nodes and **repoints** claims (SPEC-0020 §3); a
  copy/add-only gate would leave stale duplicates on `main` and defeat the very dedupe the
  Principal must be able to *see*. `sources/` is append-only, so mirroring never removes
  ground truth (DATA-2).
- **`main` never sees working paths** because they are simply never checked out into it — the
  invariant holds by construction, not by cleanup.
- **Trigger (v1):** promote after each stage drain that may have changed an evergreen path
  (archive → promote sources; later, resolve → promote entities/claims). A periodic sweep is
  the backstop, mirroring ORCH-15. (Finer per-artifact triggering is a later optimization.)

Rejected alternative: cherry-picking "evergreen commits" (needs per-commit evergreen tagging;
more moving parts). Copy-paths is dumb, deterministic, and easy to test.

## 5. What this changes (conformance)

- **Archivist (SPEC-0014/0013):** captures + archives on `staging`; the gate promotes new
  `sources/` to `main`. (Previously wrote `main` directly.)
- **Decompose (SPEC-0015):** **stops writing `entities/`**; emits **candidates** into the
  working `candidates/` path on `staging` (the #21 / CANON-4 guardrail). Until CONNECT exists,
  `entities/` is empty everywhere.
- **Claims (SPEC-0016):** works on `staging`. With no resolved entities until CONNECT, it has
  nothing to do yet (the reorder Decompose→CONNECT→Claims means Claims runs after resolution).
- **App reads (SPEC-0018 REVIEW etc.):** working state (`reviews/`, queue) is read from
  `staging`; evergreen reads (Obsidian/Query) from `main`.
- **Connect (SPEC-0020):** unchanged by this spec — it will read `candidates/` and write
  resolved `entities/` on `staging`; the gate promotes them. This spec leaves that seam clean.

## 6. Requirements

| ID         | Priority | Statement (short)                                                  | Verify   | Traces |
| ---------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| STAGING-1  | must     | A vault carries two long-lived branches: **`staging`** (work surface) and **`main`** (evergreen); `staging` is created at setup off `main` | test:staging.test.ts, stagingPipeline.test.ts | CANON-8; ORCH-2 |
| STAGING-2  | must     | **Every stage targets `staging`** — syncs its worktree to `staging` and `ff-only`-advances `staging`; **no stage writes `main`** | test:stagingPipeline.test.ts | CANON-8; ORCH-3 |
| STAGING-3  | must     | The **promotion gate** is the *only* writer of `main`; it advances `main` to hold exactly the **evergreen path set** (`sources/`, … ), never the working set | test:staging.test.ts, stagingPipeline.test.ts | CANON-1,2 |
| STAGING-4  | must     | Promotion is **copy-the-evergreen-paths** from `staging`, serialized through the shared writer lock, and **idempotent** (no-op when nothing evergreen changed) | test:staging.test.ts | CANON-2; ORCH-3 |
| STAGING-5  | must     | **Decompose emits candidates** into the working `candidates/` path on `staging` and **writes no `entities/`** (CANON-4 / issue #21); `entities/` stays empty until CONNECT | test:candidateDoc.test.ts, decomposeStage.test.ts, stagingPipeline.test.ts | CANON-4,10; DECOMP-1 |
| STAGING-6  | must     | `main` **never contains working paths** (`inbox/`, `candidates/`, `queue/`, `reviews/`) — by construction (never checked out), so Obsidian/`grep`/Query on `main` see only evergreen state | test:stagingPipeline.test.ts | CANON-1,2,8 |
| STAGING-7  | must     | App **working-state reads** (the Review queue, candidates) come from **`staging`**; **evergreen reads** (Obsidian/Query) from **`main`** | none-yet | CANON-9; REVIEW-11 |
| STAGING-8  | must     | Promotion + stage advances are **restartable / crash-safe**: branch state is the source of truth; a re-run re-promotes idempotently without duplicating `main` history divergently | test:staging.test.ts | ORCH-13 |
| STAGING-9  | should   | A **periodic sweep** re-runs promotion as a backstop (recovers a missed post-drain promotion), mirroring ORCH-15 | none-yet | ORCH-15 |
| STAGING-10 | must     | **Promotion mirrors deletions**: each promote makes every evergreen path on `main` an *exact mirror* of `staging` (adds, edits, **and removals**), so Connect's merged-away loser nodes and repointed claims (SPEC-0020 §3) are reflected on `main` — a deduped duplicate never lingers. `sources/` is append-only, so mirroring never removes ground truth | none-yet | CANON-1,2; CONNECT-3 |
| STAGING-11 | must     | The **active evergreen set** is exactly `EVERGREEN_PATHS`, and it **grows with its producers**: `entities/` + `claims/` (+ `outputs/`) join the promoted set once CONNECT/Claims write them — `EVERGREEN_PATHS` is the single source of truth for what reaches `main` | none-yet | CANON-3,5; CONNECT-3 |

## 7. Sequencing (honest — this is multi-step)

The full conformance is large; this spec is built in slices, each green + shippable:

1. **Infra + archivist:** create `staging` at setup; retarget the archivist to `staging`; add
   the promotion gate; promote `sources/` → `main`. Proves the topology end-to-end (main =
   sources only). *(This mission.)*
2. **Decompose guardrail:** Decompose → `candidates/` on `staging`, stops writing `entities/`.
   `entities/` empty on `main`. Retarget Decompose to `staging`. *(Done — this mission.)*
3. **Claims + app reads:** retarget Claims to `staging`; point the Review UI's working reads
   at `staging`. (Claims idles until CONNECT.)
4. **CONNECT (SPEC-0020) + activate derived promotion:** resolution writes evergreen
   `entities/` (deduped, linked) on `staging`; **add `entities/` + `claims/` to `EVERGREEN_PATHS`**
   (STAGING-11) and make the gate **deletion-aware** (STAGING-10) so merges/repoints reflect on
   `main`. `main`'s graph lights up — the first **viewable end-to-end enrich** flow. *(Separate
   spec/mission.)*

## 8. Open questions

- [ ] **Promotion trigger granularity** — v1 promotes after a drain; finer per-artifact or
      debounced promotion is a later optimization. Confirm the v1 coarse trigger is acceptable.
- [x] **`candidates/` shape** — RESOLVED (slice 2): **one JSON file per candidate** at
      `candidates/<dateShard(id)>/<id>.json`. Chosen over a per-source record because CONNECT's
      blocking reasons ACROSS sources (it reads all candidates, groups by kind+name), so a flat
      per-candidate file is the natural unit to read, sort, and delete-on-consume. The schema is
      SPEC-0020's already-merged `Candidate` contract — Decompose writes exactly what CONNECT reads.
- [ ] **Existing single-branch vaults** — throwaway, so slice 1 can just create `staging` on
      first run; no migration. Confirm no need to handle pre-existing dual-branch state.
- [ ] **`main` history shape** — one "promote" commit per advance vs. squashed; low-stakes
      while vaults are throwaway.

## 9. Changelog

- 2026-05-31 — created (draft). The implementing engine for SPEC-0019: two long-lived branches
  (`staging` = work surface for all stages; `main` = evergreen, written only by the
  **promotion gate**), the evergreen↔working path split, and a **copy-the-evergreen-paths**
  promotion mechanism serialized through the shared writer lock. Pins the Decompose candidates
  guardrail (no `entities/` writes) and that the app reads working state from `staging`,
  evergreen from `main`. Sequenced into slices (infra+archivist → Decompose guardrail →
  Claims+app-reads → CONNECT). Leaves resolution (SPEC-0020) untouched.
- 2026-06-02 — **slice 2 (Decompose guardrail) implemented** (STAGING-5). Decompose stops writing
  `entities/`: each entity mention the agent finds is now persisted as a per-mention **candidate**
  (`candidates/<dateShard(id)>/<id>.json`, SPEC-0020's `Candidate` contract) on `staging`, via a
  new `candidateDoc.ts` writer whose output round-trips through CONNECT's `validCandidate`. The
  dead `entityDoc.ts` (Decompose's old entity renderer — CONNECT owns the evergreen entity renderer
  in `connectDoc.ts`) was removed. `entities/` is now empty everywhere until CONNECT resolves
  (CANON-10). Resolved the `candidates/` shape open question (one JSON file per candidate). Claims
  tests now seed their entity fixture directly (the real order is Decompose→CONNECT→Claims), since
  Decompose no longer produces entities. Graduated STAGING-5 → `test:`. **Still deferred:**
  STAGING-7 (app working-reads unit coverage — e2e/IPC glue, TEST-9), STAGING-9 (periodic sweep).
- 2026-06-01 — **staging infra implemented** (PR pending). The whole pipeline now runs on a
  persistent `staging` worktree (`app/src/kb/stagingWorktree.ts`); the stages are root-agnostic,
  so handing them that worktree makes their existing queue/marker/ff-advance logic operate on
  `staging` with **no per-stage change**. The archivist's new `afterDrain` hook runs the
  promotion gate (`promote`) to publish `sources/` → `main`; `pipeline.ts` wires all stages +
  reviews onto `staging`. Integration test (`stagingPipeline.test.ts`) proves it end-to-end:
  capture+archive promote sources to `main`, Decompose's entities stay on `staging` only,
  `main` never holds working state. Graduated STAGING-1/2/3/4/6/8 → `test:`. **Deferred to
  follow-ups:** STAGING-5 (Decompose→candidates guardrail — entities still ULID-named on
  `staging`, just no longer on `main`; the candidate refactor is Connect's input, next slice),
  STAGING-7 (review reads ARE wired to `staging` in `pipeline.ts` but e2e-verified, not
  unit-tested — DOM/IPC glue, per TEST-9), STAGING-9 (sweep). All existing stage tests stayed
  green unchanged (root-agnostic), confirming the localized blast radius.
- 2026-06-01 — **deletion-aware promotion (STAGING-10/11).** Closed the gap that the v1
  copy-only gate (`git checkout staging -- P`) cannot mirror **deletions** — but Connect's
  dedupe deletes merged-away loser nodes and repoints claims (SPEC-0020 §3), so without
  mirroring, merged duplicates would linger on `main` and defeat the dedupe. Made the gate an
  **exact mirror** per evergreen path (adds/edits/removals) and pinned that `EVERGREEN_PATHS`
  grows with its producers (`entities/`+`claims/`+`outputs/` activate when CONNECT/Claims land).
  This is the spec lever for the **viewable e2e ingestion→enrich** goal (source → deduped
  entities → claims → `[[wikilinks]]`, visible on `main` in Obsidian). Impl rides slice 4.
