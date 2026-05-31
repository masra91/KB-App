---
spec: SPEC-0019
key: CANON
title: Evergreen Canonical & Working-State Isolation
type: architecture
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-31
updated: 2026-05-31
related: [SPEC-0002, SPEC-0007, SPEC-0008, SPEC-0013, SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0018]
supersedes: null
stage: Cross-cutting (the canonical invariant)
---

# Evergreen Canonical & Working-State Isolation

> The canonical KB — the `main` branch / root tree the Principal browses in Obsidian and
> that search, Query, and agents read as truth — is **always evergreen**: everything in it
> is fully resolved, valid, and human-readable. All intermediate, unresolved, pending, or
> machinery state lives in a **hidden working zone** and is promoted to the evergreen tree
> only when it is genuinely done. Every stage of every pipeline obeys this.

## 1. Intent (the why / JTBD)

The KB's value rests on a simple promise: **what you see is trustworthy.** When the Principal
opens the vault in Obsidian, greps it, or asks a question, the answer must come from coherent,
resolved knowledge — not from a half-cooked middle. Today that promise leaks:

- **Decompose writes per-source, pre-resolution extractions straight into canonical
  `entities/`** (SPEC-0015). With no cross-source resolution (DECOMP-14) this *guarantees*
  duplicates — five separate "Steve Jobs" nodes — and, once links exist, ambiguous `[[Name]]`
  links (issue #21).
- **Filenames are ULIDs** (`entities/<…>/<ULID>.md`), so the graph, quick-switcher, search,
  and `grep` are all keyed off opaque ids.
- **Processing state is invisible** — "is this node cooked?" lives only in `audit.jsonl`
  markers, so Obsidian/search/agents can't tell finished from in-flight.

The job this spec is hired for: **make "the canonical KB is evergreen" a hard, system-wide
invariant** that every stage is built against, so the messy middle never appears in the
graph and the Principal can trust everything they see — while in-progress work still exists,
durably, just *out of sight* until it's ready.

Without it, every stage independently decides what to expose, the graph fills with duplicates
and opaque names, and "is this real?" becomes a per-file judgment call.

### 1.1 Vocabulary (read this first)

| Term | Meaning |
| ---- | ------- |
| **Canonical / evergreen tree** | the `main` branch root tree — what Obsidian opens, `grep` searches, Query reads. **Resolved + valid only.** |
| **Working zone** | the hidden, durable home for everything *not yet* evergreen: raw captures, candidates, pending items, and pure machinery. |
| **Candidate** | a pre-resolution extraction — "this source *mentions* a person, Steve Jobs (evidence: …)". Provenance *about a source*, not yet an entity. |
| **Resolution** | the step (the reserved **CONNECT** stage) that clusters candidates across sources into **one** canonical entity per real-world thing. |
| **Promotion** | moving an artifact from the working zone into the evergreen tree, gated on it being resolved + valid. |

## 2. The invariant

> **CANON-1 (the invariant):** Every artifact present in the canonical evergreen tree is
> **fully resolved, valid, and human-readable.** A consumer — Obsidian's graph, full-text
> search, `grep`, Query/Ask, or any agent reading the canonical KB — may treat *everything
> it finds there* as trustworthy knowledge, with no per-file "is this real?" check.

Two corollaries make it operational:

- **Nothing unresolved is ever visible.** Pre-resolution / pending / machinery state **must
  not** appear in the canonical tree at all (CANON-2). It is not "present but tagged"; it is
  **absent** from `main`.
- **Exactly one promotion gate per kind.** Each evergreen artifact kind has a single writer —
  the stage that *resolves* it. For `entities/`, that writer is **resolution (CONNECT)**, not
  Decompose (CANON-5).

### 2.1 Two zones

| | **Evergreen tree** (`main`) | **Working zone** (hidden) |
| --- | --- | --- |
| Holds | resolved entities, their claims, outputs, immutable sources | raw captures, candidates, pending/parked items, queues, review state, audit indexes |
| Visible to Obsidian / grep / Query | **yes** — and trusted | **no** |
| Filenames | **human-readable** (the `name`) | ids / machinery names — irrelevant, never browsed |
| Writer | the resolving/promoting stage only | the producing stage |
| Mutability | versioned; sources immutable | durable + versioned (replayable), but churns |

### 2.2 Where the working zone lives — a **`staging` branch** (decided)

The working zone is a **long-lived `staging` branch off `main`** (Principal's decision,
2026-05-31: *"main and staging, and all the librarians work off staging"*). It is **hidden**
(not in the `main` tree) yet **durable + versioned** (candidates persist for resolution,
review, and dedupe — CANON-11):

- **Every librarian (stage) works off `staging`**, never `main` — Capture, Decompose,
  Connect, Claims, Research all read and write the `staging` lineage. A `main` checkout —
  Obsidian, `grep`, Query — therefore **never** contains in-progress state (the strongest
  form of "hidden": not even `grep` finds it).
- The invariant becomes **structural**, not a discipline: a working stage *cannot* pollute
  `main` because it never writes there.
- **`main` is a published view**, advanced **only** by the **promotion gate** — the step that
  moves resolved + valid artifacts `staging → main`. No working stage writes `main` directly.
- It **extends the existing machinery**: stages already run in worktrees on per-stage work
  branches (SPEC-0014); they now base those on `staging` and accumulate there durably instead
  of ff-merging each stage straight into `main`.

> **Decided over the alternative.** Recording candidates *on the source* (`audit.jsonl`/
> provenance, no separate tree) was the earlier lean (#21 / the pre-staging SPEC-0020 design),
> but it leaves candidates `grep`-able under `sources/` and gives the Enrich chain no shared
> working surface. The `staging` branch is chosen instead. **This supersedes SPEC-0020's
> original decision #1 ("candidates on-source, no staging tree"); SPEC-0020's other decisions
> stand — only *where* candidates live changes.**

Worktrees are unchanged — they remain *per-run* isolation. The evergreen/working split is
about which long-lived **ref** a stage targets (`staging` vs `main`), not about worktrees.

## 3. The per-stage pattern (every stage obeys this)

**All librarians work on `staging`.** Each stage reads and writes the `staging` lineage; the
**promotion gate** publishes resolved + valid artifacts to `main`. The Enrich order (the
reorder is **SPEC-0020 CONNECT's** call; shown here for context) puts resolution **between**
Decompose and Claims, so Claims decorates *resolved* entities:

```
                       …………… all of this happens on the `staging` branch …………
Ingest    : capture → inbox → archive → sources/                 (a source IS resolved+valid: immutable ground truth)
Decompose : source  → CANDIDATES (mentions about the source)     → writes NO entities/ (CANON-4)
CONNECT   : candidates → RESOLVE (block + match, dedup) → entities/  (unique, human-named, linked)   ← sole entities/ writer
Claims    : RESOLVED entity → claims about it
Research  : resolved entity → external corroboration
Review    : the "needs you" queue — machinery; answers feed Ingest (notes → sources)
                       ……………………………………………………………………………………………………………………
                                  │  PROMOTION GATE: resolved + valid artifacts
                                  ▼
`main`  (EVERGREEN): sources/ + resolved entities/ (+ their claims) + outputs/ — what Obsidian/grep/Query see
```

Consequences this spec accepts honestly:

- **`main` is published, not worked-on.** No librarian writes `main`; they all churn on
  `staging`, and the promotion gate copies forward only what is resolved + valid. The exact
  promotion trigger/mechanics (which stage promotes, and when) are **SPEC-0020 / ORCH**
  territory — this spec fixes only the *invariant* they must satisfy.
- **Sources are evergreen on archive.** A primary/secondary source is resolved-and-valid the
  moment it is archived (immutable ground truth, DATA-2), so it is promotion-eligible directly
  out of Ingest — no resolution pass needed.
- **The pre-resolution middle is real and large.** Decompose's candidates, the Review queue,
  and any other in-flight state all live on `staging` and never reach `main` until promoted —
  which, for entities, means **after CONNECT resolves them** (SPEC-0020).
- **Review is machinery.** The "needs you" queue (SPEC-0018) is workflow state, not knowledge;
  it belongs in the working zone (hidden), not the browsable vault. Its *answer-notes* enter
  the evergreen world only by going through Ingest as sources (REVIEW-7), like any capture.

## 4. Naming — human-readable evergreen, stable identity underneath

Evergreen knowledge is for humans (and Obsidian's graph); identity is for the machine. These
are **decoupled** (CANON-6):

```markdown
entities/person/Steve Jobs.md
---
id: 01JABCG9…           # stable ULID — the real identity; lineage/provenance key off THIS
aliases: [01JABCG9…]    # so id-based search / old links keep resolving through renames
kind: person
name: Steve Jobs
---
# Steve Jobs
```

- **Filename = the human `name`** (CANON-6). The ULID is demoted to `id:` frontmatter plus an
  Obsidian `aliases:` entry. `grep "Steve Jobs"`, the quick-switcher, and the graph all work.
- **Identity is the `id`, never the filename.** Lineage (`audit.jsonl`, `provenance.
  derivedFrom`) references the stable `id`, so resolution may **rename or merge** nodes freely
  without breaking provenance.
- **Collisions are disambiguated by folder structure under `entities/`** (CANON-7) — e.g.
  `entities/<kind>/<name>.md`, and within a kind a further qualifier folder or a suffix
  (`entities/person/Steve Jobs (Apple).md`) when two real things share a name+kind. The exact
  partitioning is flexible (architecture, §6); the **non-negotiable is human-readable
  filenames** — never a ULID filename in evergreen.

## 5. Scope — this spec is the **principle**, not the implementation

SPEC-0019 is the **governing invariant** the rest of the system must conform to. It owns:
- CANON-1 the evergreen invariant + the two-zone (`main`/`staging`) model + the staging
  mechanism (§2);
- the per-stage pattern (§3) and the naming convention (§4) every stage must satisfy.

**It deliberately makes no code-contract amendments itself.** The concrete edits that bring
existing stages into conformance land with the stage that drives them — chiefly **SPEC-0020
(CONNECT)**, which reorders the Enrich chain and becomes the sole `entities/` writer:

| Conformance change | Owned by |
| ------------------ | -------- |
| Decompose emits **candidates**, stops writing `entities/` | SPEC-0020 (CONNECT) — amends SPEC-0015 |
| Claims' work-unit on **resolved** entities (per entity × source) | SPEC-0020 — amends SPEC-0016 |
| DATA: canonical = resolved-only; identity ≠ filename; human naming | SPEC-0020 — amends SPEC-0007 |
| ORCH: stages target `staging`; the promotion gate advances `main` | with the **staging-branch implementation** (ORCH amendment / mission), referencing this spec |

So this spec **points**; SPEC-0020 and the staging-branch mission **do**. This keeps a single
writer per amended spec and avoids two agents editing the same merged-stage specs at once.

**Out of scope (for now):**
- The resolution algorithm + the exact pipeline reorder — **SPEC-0020 (CONNECT)**.
- The promotion-gate mechanics (trigger, which step advances `main`) — ORCH amendment / the
  staging-branch mission.
- Migration of existing vaults — all current vaults are throwaway; previously-written
  ULID-named / duplicate entities are disposable (zero migration cost — a good time to lock
  the invariant).
- A working-zone *viewer* in the app (browsing `staging`/candidates outside Obsidian) — future.

## 6. Requirements

| ID        | Priority | Statement (short)                                                  | Verify   | Traces |
| --------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| CANON-1   | must     | The canonical `main` tree is **evergreen**: every artifact in it is fully resolved + valid + human-readable; consumers may trust all of it without per-file checks | none-yet | PRIN-1; VISION-4 |
| CANON-2   | must     | Pre-resolution / pending / machinery state **must be absent from `main`** (not merely tagged) — it lives only in the hidden working zone | none-yet | PRIN-1; DATA-1 |
| CANON-3   | must     | Every stage produces into the **working zone** and **promotes to evergreen only when resolved + valid**; promotion is a deliberate gate, not a side effect | none-yet | ORCH-3; LIFE-3 |
| CANON-4   | must     | **Decompose emits candidates (mentions about a source), not entities**; it does **not** write canonical `entities/` (resolves issue #21; the DECOMP edit lands with **SPEC-0020**) | none-yet | DECOMP-1; DATA-3 |
| CANON-5   | must     | `entities/` has **exactly one writer — resolution (CONNECT)**; each evergreen entity is unique, real, human-named, and linked | none-yet | DATA-3; LIFE-3 |
| CANON-6   | must     | Evergreen derived notes use **human-readable filenames** (the `name`); the ULID is `id:` frontmatter + an `aliases:` entry; **identity keys off `id`, never the filename** | none-yet | DATA-3,5; PRIN-13 |
| CANON-7   | must     | Filename collisions are disambiguated by **folder structure under `entities/`** (and/or a suffix) — **never** by reverting to a ULID filename | none-yet | DATA-3 |
| CANON-8   | must     | The working zone is a **`staging` branch** off `main`; all librarians work on `staging` and only the promotion gate advances `main`, so Obsidian, search, and `grep` on a `main` checkout never surface non-evergreen state | none-yet | PRIN-1; VISION-4 |
| CANON-9   | must     | Pure **workflow machinery** (queues, the review "needs you" queue, candidate buffers, audit indexes) stays in the working zone — it is not knowledge and never appears in the evergreen graph | none-yet | DATA-10; AUTO-10 |
| CANON-10  | should   | Until resolution exists, evergreen `entities/` is **empty** — honest emptiness is preferred over unresolved duplicates (v1 posture) | none-yet | PRIN-1 |
| CANON-11  | must     | The working zone is **durable + versioned** (replayable) — candidates persist for resolution, review, and dedupe; it is not ephemeral scratch | none-yet | DATA-9,11; LIFE-10 |
| CANON-12  | must     | Worktrees remain **per-run isolation** only; the evergreen/working split is about which long-lived **ref** a stage targets (`staging` vs `main`), not the worktree mechanism | none-yet | ORCH-2 |
| CANON-13  | must     | Evergreen knowledge is **Obsidian-native** human-readable markdown (graph/search work well); working state carries **no wikilinks** into the evergreen graph | none-yet | PRIN-13; VISION-4 |

### CANON-1 — The evergreen invariant
- **Status:** draft · **Priority:** must
- **Statement:** Everything present in the canonical `main` tree **MUST** be fully resolved,
  valid, and human-readable. Any consumer reading the canonical KB **MUST** be able to treat
  all of it as trustworthy without a per-artifact validity check.
- **Rationale:** Trust is the product. A KB you must second-guess file-by-file is not a second
  brain. Making evergreen a hard invariant (not a per-stage choice) is what lets Obsidian,
  search, Query, and agents all rely on the same guarantee.
- **Traces:** PRIN-1, VISION-4
- **Verify:** none-yet

### CANON-4 — Decompose emits candidates, not entities
- **Status:** draft · **Priority:** must
- **Statement:** Decompose **MUST** record its per-source extractions as **candidates**
  (mentions, with evidence, as provenance about the source) in the working zone, and **MUST
  NOT** write canonical `entities/`. The canonical entity graph is produced only by resolution.
- **Rationale:** Per-source extraction is inherently pre-resolution (DECOMP-14 does no
  cross-source dedup), so writing it to `entities/` *guarantees* duplicates and ambiguous
  links (issue #21). Keeping candidates out of canonical makes "no dupes" structural.
- **Traces:** DECOMP-1, DECOMP-14, DATA-3
- **Verify:** none-yet

### CANON-6 — Human filenames, stable id underneath
- **Status:** draft · **Priority:** must
- **Statement:** An evergreen derived note's **filename MUST be its human `name`**; its ULID
  **MUST** live in `id:` frontmatter and an Obsidian `aliases:` entry. All lineage and
  provenance **MUST** reference the `id`, never the filename, so resolution can rename/merge
  without breaking history.
- **Rationale:** Obsidian's graph, quick-switcher, search, and `grep` are keyed off filenames;
  ULID filenames make the whole vault unreadable. Decoupling identity (id) from presentation
  (filename) gives both human readability and rename-safe lineage.
- **Traces:** DATA-3, DATA-5, PRIN-13
- **Verify:** none-yet

### CANON-8 — Working state lives on a `staging` branch
- **Status:** draft · **Priority:** must
- **Statement:** Non-evergreen state **MUST NOT** be reachable from a `main` checkout. The
  mechanism is a long-lived **`staging` branch** off `main`: every librarian (stage) reads
  and writes `staging`, and **only the promotion gate advances `main`** (with resolved + valid
  artifacts). No working stage writes `main`.
- **Rationale:** "Hidden" must be strong enough that `grep`/Obsidian/Query never trip over
  candidates. A separate ref makes the invariant structural — a working stage can't reach
  `main` because it never targets it. (Principal's decision, 2026-05-31, over the on-source
  alternative — see §2.2.)
- **Traces:** PRIN-1, VISION-4
- **Verify:** none-yet

## 7. Open questions

- [x] **Working-zone mechanism** — *resolved (Principal, 2026-05-31):* a **`staging` branch**
      off `main`; all librarians work on `staging`, the promotion gate advances `main`. Chosen
      over candidates-on-source (rejected: `grep`-able under `sources/`, no shared working
      surface). **Supersedes SPEC-0020's original decision #1.**
- [ ] **`entities/` partitioning for collisions** — `entities/<kind>/<name>.md` vs. deeper
      qualifier folders vs. name-suffixes. Flexible; pin when CONNECT (the writer) is specced.
      The hard requirement is *human-readable filenames*, not the exact tree.
- [ ] **Promotion-gate mechanics** — *which* step advances `main` and *when* (does CONNECT
      promote on resolve? a dedicated promote pass after Claims? what makes an entity "stable
      enough"?). Belongs to SPEC-0020 / the ORCH staging-branch amendment; this spec fixes only
      the invariant the gate must satisfy.
- [ ] **Staging-branch hygiene** — a churning staging lineage grows; do we periodically
      squash/compact it, or let history accumulate? (Throwaway vaults make this low-stakes now.)
- [ ] **Outputs (`outputs/`)** — synthesis artifacts are Principal-initiated (AUTO-5) and
      arguably evergreen-on-creation; confirm they need no staging pass. (Likely evergreen
      directly, like sources.)

## 8. Changelog

- 2026-05-31 — created (draft). Captured the **evergreen canonical invariant** (issue #21,
  generalized): the `main` tree is resolved + valid + human-readable only; all pre-resolution
  / pending / machinery state lives in a **hidden working zone** (recommended: a staging
  branch off `main`) and is **promoted** to evergreen only when done. Pins the per-stage
  pattern (Decompose emits **candidates**, not entities; **resolution/CONNECT is the sole
  `entities/` writer** and promotion gate), the **human-filename / stable-id** naming
  (collisions via folder structure, never ULID filenames), and that workflow machinery
  (queues, the Review queue) stays hidden. v1 posture (Principal's call): **lock the invariant
  + the Decompose guardrail only; `entities/` empty until CONNECT later.** Open: the
  working-zone mechanism, `entities/` collision partitioning, and the promotion gate.
- 2026-05-31 — **locked the working-zone mechanism: a `staging` branch** (Principal — "main and
  staging, all the librarians work off staging"). `main` = evergreen published view, advanced
  only by the promotion gate; every stage works on `staging`. **Supersedes SPEC-0020's original
  "candidates on-source, no staging tree" (decision #1); its other decisions stand.** Reframed
  §5: this spec is **principle-only** — it states the invariant + staging + naming and *points*
  to **SPEC-0020 (CONNECT)** for the code-contract amendments (DECOMP→candidates, CLAIMS
  work-unit, DATA resolved-only/naming) and to the ORCH staging-branch amendment for promotion
  mechanics, so two agents don't edit the same merged-stage specs. Aligned §3 to SPEC-0020's
  reorder (Decompose → CONNECT → Claims).
