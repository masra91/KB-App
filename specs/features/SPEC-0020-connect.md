---
spec: SPEC-0020
key: CONNECT
title: Connect & Expand (Enrich v3)
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-31
updated: 2026-05-31
related: [SPEC-0003, SPEC-0004, SPEC-0006, SPEC-0007, SPEC-0008, SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0018, SPEC-0019]
supersedes: null
stage: Enrich
---

# Connect & Expand (Enrich v3)

> The Enrich stage that makes the graph **coherent**: it resolves the per-source entity
> *candidates* Decompose extracts into **one canonical node per real-world thing**
> (deduped, human-named), and **promotes** the `relatesTo` hints Claims leaves into real
> Obsidian `[[wikilinks]]` so the graph view lights up. Connect is the **sole writer of
> `entities/`** — the canonical graph only ever shows resolved, polished output, never the
> messy per-source middle. The fourth user of the SPEC-0014 harness, and the first that
> reasons *across* items rather than over one in isolation.

## 1. Intent (the why / JTBD)

Decompose (SPEC-0015) and Claims (SPEC-0016) are deliberately **zero-resolution**: each
mints fresh, per-source output and never reconciles across sources (DECOMP-14, CLAIMS-17).
That was the right skeleton, but it leaves the canonical graph **incoherent** — five
separate "Steve Jobs" nodes from five sources, opaque ULID filenames, and no edges between
related things (issue #21). A second brain whose graph is full of duplicates and has no
links is not yet *connected knowledge* (VISION-5/6); it is an index with redundancy.

Connect is the stage SPEC-0016 §1.1 reserved the **Link** vocabulary for, and the one the
lifecycle calls *Connect & Expand* (LIFE-3). It does the two jobs the thin stages
deferred to it:
- **Connect (resolve):** cluster entity candidates that refer to the same real-world thing
  and emit **one canonical node** per thing — deduped, with a clean human filename.
- **Expand (link):** turn Claims' soft, unresolved `relatesTo` hints into **established,
  reconciled `[[wikilinks]]`** between canonical nodes, so Obsidian's graph view works.

It is the stage that operationalizes the **evergreen canonical invariant** that SPEC-0019
(CANON) now governs: *unresolved extraction must never appear in the canonical graph.*
`entities/` becomes **resolution output with exactly one writer — Connect** (CANON-5), and
Connect is the stage CANON §5 explicitly points to for the code-contract amendments.

### 1.1 The pipeline reorders, and the staging model (read this first)

This spec **changes the shape of the Enrich pipeline** (and therefore amends two already-
shipped stages) **within the two-zone model SPEC-0019 established.** Before:

```
sources/ → Decompose → entities/ (per-source, duplicated)  → Claims → claims/   [all on main]
```

After — all librarians work on the **`staging` branch** (CANON-8); only the **promotion
gate** advances the evergreen **`main`**:

```
………………………………… on the `staging` branch (the hidden working zone) …………………………………
sources/ → Decompose → CANDIDATES (in the working zone, NOT in the graph)
                          │
                          ▼
                       Connect → entities/ (canonical, deduped, human-named, linked)  ← sole entities/ writer
                          │
                          ▼
                       Claims → claims/ (+ entity node substance)
………………………………………………………………………………………………………………………………………………………………
                          │  PROMOTION GATE (resolved + valid only; CANON-3): staging → main
                          ▼
`main` (EVERGREEN): sources/ + resolved entities/ (+ claims) + outputs/ — what Obsidian/grep/Query see
```

- **Decompose stops writing `entities/`.** It emits **candidates** into the **working zone**
  (CANON-4). Per SPEC-0019 §2.2 the working zone is the **`staging` branch** — candidates are
  **not** recorded on the source / under `sources/` (that earlier lean was explicitly
  superseded by CANON-8). See §3.1 and the SPEC-0015 amendment in §8.
- **Connect is the sole writer of `entities/`** (CANON-5). It clusters candidates across
  sources and writes born-resolved nodes. Until Connect runs, evergreen `entities/` is empty —
  honest, and strictly better than duplicates (CANON-10).
- **Promotion gate, not direct `main` writes.** Connect (like every stage) works on
  `staging`; resolved + valid entities reach `main` only via the promotion gate. The gate's
  *mechanics* (which step promotes, and when) are **ORCH / the staging-branch mission**
  (CANON §5, §7), not pinned here; this spec assumes the gate exists and produces *into*
  evergreen-eligible state.
- **Claims runs after Connect** (unchanged position relative to entities), but its work
  unit shifts because a resolved entity may derive from **many** sources — see §3.6 and the
  SPEC-0016 amendment in §8.

### 1.2 Vocabulary — Candidate vs. Node vs. Link (extends SPEC-0016 §1.1)

| Term | Stage | What it is | Lives in | Status |
| ---- | ----- | ---------- | -------- | ------ |
| **Candidate** | **Decompose** | a *per-source mention* of a possible entity: `kind` + `name` + evidence, **unresolved** | the **working zone** (`staging`; CANON-8) | 🔲 this spec (amends 0015) |
| **Node** (entity) | **Connect** | a *resolved, canonical thing*: one per real-world entity, human-named, deduped | canonical **`entities/`** | 🔲 **this spec** |
| **Claim** | **Claims** | an *assertion a source makes about a node* | **`claims/`** | ✅ SPEC-0016 |
| **Link** (typed edge) | **Connect** | a *reconciled relation between canonical nodes*, rendered as an Obsidian `[[wikilink]]` | inside the **entity node** (generated block) | 🔲 **this spec** |

The dividing line this spec adds: **Candidate vs. Node.** A candidate is "*source X mentions
something it calls Steve Jobs*" — provenance about a source, possibly one of many duplicates.
A node is "*Steve Jobs, the person* — here is the single canonical page, derived from sources
X, Y, Z." Decompose produces candidates; **only Connect produces nodes.**

## 2. Scope

**In scope (v1 = both resolution AND links):**
- A **Connect stage**: one instance of the SPEC-0014 harness (own worktree, own versioned
  instruction file, own model) — the **sole writer of `entities/`**.
- **Blocking (deterministic, orchestrator):** group unresolved candidates into **candidate
  sets** by a cheap key (normalized name + `kind`), so the agent never has to scan the whole
  graph (§3.2). This is what keeps Connect a **thin** stage.
- **Matching (thin agent):** given one candidate set (+ any existing canonical nodes that
  block to the same key), return a **resolution verdict** — which candidates are the same
  real thing, the canonical name, and which existing node (if any) they belong to (§3.3).
- **Born-resolved nodes:** the orchestrator writes **one canonical node per real thing**,
  with a **human filename** (`entities/<kind>/<slug>.md`), the stable ULID demoted to `id:`
  frontmatter + an Obsidian `aliases: [<ULID>]`, and `provenance.derivedFrom` listing **all**
  contributing sources/candidates (§3.4).
- **Merge of existing nodes:** when new candidates resolve to an existing node, **fold them
  in** (extend `derivedFrom`); when two existing nodes are found to be the same, pick a
  **canonical** one, **repoint** references, and **delete** the loser (git keeps it
  recoverable — no tombstone files; §3.5).
- **Claim re-pointing:** when nodes merge, repoint affected claims' `subject` to the
  canonical node and regenerate the node's claims block; **Claims is not re-run** (§3.6).
- **Link promotion (Expand):** read the `relatesTo` hints on a node's claims, resolve each
  to a canonical node, and render a **delimited, regenerated `[[wikilinks]]` block** in the
  entity node so the Obsidian graph connects (§3.7).
- **Review escalation:** ambiguous merges/links raise a yes/no **Review** (SPEC-0018) via
  the decision channel; the item parks until answered, then resumes — never a silent guess
  (§3.8).
- Reuse of the **signal channel** + **audit envelope** (SPEC-0015/0016 §3.4).

**Out of scope (for now):**
- **Enrich & Research** (RESEARCH) — external corroboration/expansion; egress (AUTO-4), a
  thick agent. A separate later stage.
- **Typed-relation predicates as first-class data** — v1 links are `[[wikilinks]]`
  (untyped edges that make the graph connect). A *typed* edge ("Steve —manages→ Austin",
  with its own confidence/evidence/predicate) is a richer later slice; v1 may record the
  predicate as link text but does not build link-as-object files (§3.7, §7).
- **Ongoing reconciliation / recooks** — v1 resolves on the forward pass + a re-poke sweep;
  scheduled cron-style reconcilers that re-cluster the whole graph as it grows are a later
  **Reflect**-adjacent concern (LIFE-8). v1 merges are correct-when-made, not continuously
  re-evaluated.
- **Splitting an over-merged node** — if a merge later proves wrong, v1 relies on git
  history + a Review-driven manual correction; an automated un-merge is deferred.
- **Cross-`kind` resolution** — v1 blocks within a single `kind` (a `person` Steve never
  merges with a `project` Steve). Cross-kind is deferred.

## 3. The stage (flow)

Connect is **the same SPEC-0014 harness as the archivist / Decompose / Claims, with
different config** — its own worktree + instruction file (ORCH-9). The engine does not
change; this is the fourth proof of the reuse it was justified by. What *is* new: Connect's
work unit is a **candidate set** (a cross-source cluster), not a single item — but the agent
still sees one bounded set and returns one JSON verdict, so the **thin-agent contract holds**
(§3.3). All of this runs on the **`staging` branch** (CANON-8); the promotion gate later
publishes resolved entities to `main`.

```
DECOMPOSE emits candidates into the working zone (no entities/ writes) ─────────┐
                                                                                  ▼
ORCHESTRATOR (deterministic BLOCKING): scan all sources' un-resolved candidates,
  group by normalized(name) + kind  →  candidate sets; pull existing entities/ nodes
  that block to the same key into the set                                         │
                                                                                  ▼
[CONNECT AGENT]  copilot -p, fresh session, no tools (ORCH-5,7)
   in:  one candidate set (N candidates + any existing same-key nodes + their claims' names)
   out: JSON verdict { clusters[], links?, reviews?, signals? }
   ▼
ORCHESTRATOR (deterministic effects — ORCH-7):
   ├─ validate verdict against schema (invalid → flag + retry, never lose; ORCH-12)
   ├─ for each cluster: choose/create canonical node (human filename, id+aliases),
   │     extend provenance.derivedFrom with all contributing sources,
   │     repoint affected claims' subject, delete merged-away loser nodes
   ├─ promote relatesTo hints → resolve targets → regenerate the node's [[links]] block
   ├─ mark the consumed candidates resolved (in the working zone)
   ├─ append audit events (+ signals), envelope-wrapped (ORCH-11)
   ├─ commit the graph delta ("connect: <canonical> from N candidates")
   ├─ commit on `staging`; the PROMOTION GATE later publishes resolved entities → `main` (CANON-3,8)
   └─ raise reviews + park if the verdict was uncertain (SPEC-0018)
   ▼
entities/   (on `staging`; promoted to evergreen `main` — the graph the Principal browses)
```

### 3.1 What Decompose now emits — candidates (amends SPEC-0015)

Decompose's agent decision is **unchanged** (still `{ entities[], signals? }` — the model
still "extracts entities"). What changes is the **orchestrator effect**: instead of writing
`entities/<ULID>.md`, Decompose records each extraction as a **candidate in the working
zone** (the `staging` branch; SPEC-0019 CANON-4/8).

- Candidates live in the **working zone**, not in `main` and **not** under `sources/` — so a
  `main` checkout (Obsidian, `grep`, Query) never surfaces them (CANON-2/8). They are written
  to a working-zone path on `staging` (layout pinned with the staging-branch implementation),
  keyed so Connect can find unresolved ones. *(The earlier "record candidates on the source /
  no staging tree" lean was **superseded** by CANON-8 — SPEC-0019 §2.2.)*
- A candidate carries what Connect's blocking needs: `kind`, `name`, `mentions` (evidence),
  the `sourceId` it came from, and a stable candidate id.
- **`entities/` is no longer written by Decompose.** The DECOMP-1/5 "writes entity nodes"
  requirement is amended to "emits entity **candidates**" (see §8).

> Migration: existing throwaway vaults with ULID-named/duplicate entity nodes are
> disposable (issue #21 / CANON). No data migration is built; the invariant is locked now
> while the cost is ~zero.

### 3.2 Blocking — the deterministic cross-graph scan (orchestrator)

The orchestrator, not the agent, does the cross-source grouping. This is the move that lets
Connect stay thin: the agent never holds the whole graph, only one bounded candidate set.

- **Block key:** `kind` + a normalized name (lowercased, trimmed, punctuation/whitespace
  collapsed). All candidates (and existing nodes) sharing a block key form one **candidate
  set**.
- Blocking is a **recall-first heuristic**, deliberately loose: it over-groups (cheap) and
  lets the agent split false positives (precise). Exact-normalized-match is the v1 key; richer
  blocking (nicknames, acronyms, embeddings) is a later refinement that needs **no** schema
  change.
- A candidate set with exactly one member and no existing node is the trivial case: the
  agent confirms it as a new canonical node (still goes through the agent so naming is
  consistent).

### 3.3 The agent verdict (the only thing the agent produces)

The agent receives **one candidate set** and returns **only** this JSON. It writes nothing,
mints no ids, and resolves only *within the set it was given*.

```json
{
  "blockKey": "person|steve jobs",
  "clusters": [
    {
      "canonicalName": "Steve Jobs",
      "memberCandidateIds": ["01JC…a", "01JC…b"],
      "existingNodeId": "01JB…",
      "confidence": 0.95
    },
    {
      "canonicalName": "Steve Jobsen",
      "memberCandidateIds": ["01JC…c"],
      "confidence": 0.9
    }
  ],
  "links": [
    { "fromCandidateOrName": "Steve Jobs", "to": "Apple", "predicate": "founded", "confidence": 0.8 }
  ],
  "reviews": [
    { "question": "Is the 'S. Jobs' in source 3 the same person as Steve Jobs?",
      "detail": "Source 3 only says 'S. Jobs'; could be a different person.",
      "refs": ["S. Jobs", "Steve Jobs"] }
  ],
  "signals": [
    { "type": "note", "note": "Two plausible spellings; kept separate pending more evidence." }
  ]
}
```

- **`clusters[]`** (required): each is a set of candidates the agent judges to be **the same
  real thing**, plus the chosen `canonicalName`, an optional `existingNodeId` (fold into that
  node), and a `confidence`. The agent **splits** the loosely-blocked set into one cluster
  per distinct real thing — so the block over-groups and the agent disambiguates. A **blank**
  `existingNodeId`/`mergeExistingNodeIds` entry (`""`/whitespace) is **coerced to absent** — the
  agent saying "no existing node to fold into" is benign (the cluster is born fresh), not a parse
  error that should fail the block (#136 robustness; CONNECT-14).
- **`links[]`** (optional): promotions of `relatesTo` hints — each names a source end (a
  cluster's `canonicalName`) and a target (`to`), an optional `predicate` (link text), and a
  `confidence`. The orchestrator resolves `to` against canonical nodes (§3.7).
- **`reviews[]`** (optional): yes/no escalations (SPEC-0018) for genuinely ambiguous
  merges/links — the item parks, no merge applied, until answered (§3.8).
- **`signals[]`** (optional): the audit-only escape hatch (SPEC-0015 §3.3), unchanged.

### 3.4 The canonical node (what the orchestrator writes)

Born-resolved, human-named, orchestrator-authored:

```markdown
---
id: 01JB…                            # stable canonical entity ULID (survives renames/merges)
kind: person
name: Steve Jobs
aliases: ["01JB…", "Steve Jobsen?"]  # ULID (id-search), prior names/spellings folded in
confidence: 0.95
provenance:
  derivedFrom:                       # ALL contributing sources (a resolved node is multi-source)
    - sources/2026/05/30/01JA…x
    - sources/2026/05/31/01JA…y
  resolvedFrom: ["01JC…a", "01JC…b"] # the candidate ids this node consumed (lineage)
  transformedBy: "connect · copilot (…)"
createdAt: 2026-05-31T…Z
updatedAt: 2026-05-31T…Z
---

# Steve Jobs

<!-- kb:links:start (generated — edit via Connect, not here) -->
- founded [[entities/organization/apple]]
<!-- kb:links:end -->

<!-- kb:claims:start (generated — edit claims/, not here) -->
- [[claims/…]] — Co-founded Apple in 1976. *(fact, 0.98)*
<!-- kb:claims:end -->
```

- **Human filename:** `entities/<kind>/<slug(name)>.md` (e.g. `entities/person/steve-jobs.md`).
  Identity is the `id:` in frontmatter, **not** the filename — so Connect can rename freely
  on a better name without breaking lineage (issue #21). On a slug collision within a kind,
  disambiguate deterministically (e.g. append a short id suffix).
- **`aliases`** keeps Obsidian quick-switcher / `[[ULID]]` links / prior-spelling search
  working through renames and merges.
- **`derivedFrom`** lists **every** source that contributed — this is the multi-source fact
  that Claims must now handle (§3.6).
- The node carries the **generated `[[links]]` block** (§3.7) and, after Claims runs, the
  existing generated **claims block** (CLAIMS-9). Connect owns the links block; Claims owns
  the claims block; identity frontmatter is written once by Connect. Disjoint regions.

### 3.5 Merge mechanics (resolution)

- **New candidates → existing node:** extend the node's `derivedFrom` + `resolvedFrom`, fold
  any new spelling into `aliases`, bump `updatedAt`. No new node.
- **New candidates → new node:** mint a canonical ULID, write the node with a human filename.
- **Two existing nodes are the same thing:** choose a **canonical** node (e.g. oldest id /
  most sources), repoint every reference (claims `subject`, other nodes' links) to it, fold
  the loser's `derivedFrom`/`aliases` in, and **delete the loser file**. Git history keeps it
  fully recoverable — **no tombstone/alias stub files** (Principal's call: avoid cruft).
- All of this happens in the worktree and lands as **one commit** per resolved block, through
  the shared serialized canonical writer (ORCH-3). Deleting a node is a normal tracked
  deletion; the prior content lives in history (DATA-11) and a merge is reversible via git.

### 3.6 What merging does to Claims (amends SPEC-0016)

A resolved node may derive from **many** sources — which breaks CLAIMS-5's "one entity ↔ one
source" assumption (the open question SPEC-0016 §7 deferred "to Connect"). v1 resolution:

- **Repoint, don't re-run (Principal's call, Q2=a).** When nodes merge, the orchestrator
  repoints affected claims' `subject` to the canonical node and **regenerates** the canonical
  node's claims block (CLAIMS-9 machinery, reused). Existing claims are **not** re-derived.
- **Claims' work unit becomes (entity × source).** Because a node now has many `derivedFrom`
  sources, Claims derives claims **per (entity, source) pair** — each claim still has exactly
  one source in its `evidence.derivedFrom` (CLAIMS-6 stays intact), and the node accumulates
  claims from all its sources. SPEC-0016's derived work-list + `claimed` marker become keyed
  by `(entityId, sourceId)` rather than `entityId` alone (see §8 amendment).
- **No claim dedup in v1.** Two sources asserting the same thing still yield two claims
  (CLAIMS-17 holds); collapsing them is a later Reflect/recook concern, fed by
  `possible-duplicate` signals.

### 3.7 Link promotion — Expand (the graph lights up)

> **Status: BUILT (CONNECT-12/13).** Link promotion consumes Claims' `relatesTo` hints
> (SPEC-0016 §3.2) — but the Enrich reorder runs Connect *before* Claims, so on the first
> resolution pass those hints don't exist yet. So link promotion is a **Connect re-pass after
> Claims**: `ConnectStage`'s drain runs a link pass (`readLinkQueue`/`linkOne`) after the
> candidate pass, triggered by Claims' `afterDrain` poke (plus the periodic sweep backstop).
> Resolution is **deterministic** (CONNECT-20 typed-link-as-object stays deferred): each
> `relatesTo` name resolves by normalized name to a canonical node — exactly-one match → a
> `[[wikilink]]`; zero match → a `note` signal; **ambiguous (>1 same-named entity) → a yes/no
> Review** (CONNECT-15) — never a dangling guess (CONNECT-13). The
> block is regenerated WHOLE (idempotent — re-poke/replay re-promote the delta only). The
> resolver core (§3.2–3.6) shipped first (slices 1–2); this is slice 3.

The Principal's directive: **links are real Obsidian `[[wikilinks]]`**, kept updated and
preserved; **not** link-as-file objects unless we genuinely need rich per-link metadata
(deferred, §7). The graph view must work.

- After resolving a block, the orchestrator reads the `relatesTo` hints on the canonical
  node's claims (Claims left them; SPEC-0016 §3.2) plus any `links[]` the agent returned, and
  resolves each target name to a **canonical node** (via the same blocking key; unresolved
  targets become a `note` signal or a Review, never a dangling guess).
- It renders a **delimited, regenerated links block** inside the entity node:
  `<!-- kb:links:start --> … <!-- kb:links:end -->`, each line `predicate [[entities/<kind>/<slug>]]`.
  Regenerated **whole** (idempotent), exactly like the claims block — so re-pokes/replays
  converge and human edits inside the markers are expected to be overwritten.
- Links use the canonical node's path/name so they resolve in Obsidian and the **graph view
  connects**. Because links are plain `[[wikilinks]]` in the markdown, the graph works with
  zero extra machinery (the Principal's hard requirement). A future typed-link-as-object
  model can layer on without removing the wikilinks (§7).

### 3.8 Review escalation (uses SPEC-0018)

Connect is the first stage where a wrong autonomous action is **worse than a wrong claim** —
conflating two real things, or asserting a false relation. So it leans on Review (now merged):

- **Auto-resolve above confidence; escalate below.** High-confidence clusters/links apply
  silently (AUTO-1: reversible, audited). A genuinely ambiguous merge/link the agent raises
  as a yes/no `ReviewRequest` in its verdict (`reviews[]`), reusing the exact channel Claims
  uses (`app/src/kb/reviews.ts`).
- **Park, don't guess.** When a review is raised for a block, the orchestrator **applies no
  merge for the affected cluster** and parks it (the SPEC-0018 raise → park → answer → resume
  pattern); other unambiguous clusters in the same set still resolve. On answer, the block
  re-runs with the verdict fed back as authoritative context (REVIEW-6).
- This is what unblocks "be aggressive about coherence without risking false merges": the
  conservative path is always available and never silently taken.

### 3.9 Signals & audit envelope (reused)

Identical mechanism to SPEC-0015 §3.3–3.4 / SPEC-0016 §3.4: optional `signals[]`
(`{type, note, refs?}`, open vocab) → **audit log only**; the orchestrator wraps every effect
+ signal in the rigid envelope (`ts, runId, stage:"connect", blockKey, model, event`) and
appends JSONL. Structure in the envelope, freedom in the payload.

### 3.10 Edge flows (failure tolerance)

- **Invalid / malformed verdict** — the candidate set stays unresolved, the failure is
  audited and retried; after **K** attempts the block is **set aside** (does not head-of-line-
  block the work-list) — never dropped (ORCH-12). The agent has no write tools.
- **Crash mid-resolve** — candidates are only marked resolved in the same commit that writes
  the node; on restart the orchestrator re-reads unresolved candidates and re-resolves.
  Idempotent (ORCH-13). A re-run regenerates node/link/claim blocks whole.
- **Empty / trivial block** — a single unambiguous candidate becomes one new node and
  dequeues cleanly. A valid outcome.
- **Window closed** — Connect runs headless on the orchestrator like every stage (ORCH-1).

## 4. Requirements

| ID          | Priority | Statement (short)                                                  | Verify   | Traces |
| ----------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| CONNECT-1   | must     | A Connect stage resolves per-source entity **candidates** into **canonical nodes** in `entities/`, deduped one-per-real-thing | test:connectStage.test.ts | LIFE-3; VISION-5 |
| CONNECT-2   | must     | Connect is **one instance of the SPEC-0014 harness** (own worktree, own instruction file/model); the engine is reused unchanged | test:connectStage.test.ts | ORCH-9 |
| CONNECT-3   | must     | **`entities/` has exactly one writer — Connect.** Decompose emits candidates into the working zone (`staging`; CANON-8), not entity nodes; unresolved extraction never appears in the canonical graph | test:connectStage.test.ts | DATA-1; CANON-2,4,5 |
| CONNECT-4   | must     | **Blocking is deterministic (orchestrator):** candidates are grouped into candidate sets by `kind` + normalized name; the agent receives one bounded set, never the whole graph | test:connect.test.ts, connectStage.test.ts | ORCH-7 |
| CONNECT-5   | must     | The Connect agent is **thin / cognition-only**: given one candidate set it returns a resolution verdict; it is granted **no** shell/write/git tools; the orchestrator performs all effects | test:connectAgent.test.ts | ORCH-7; AUTO-3 |
| CONNECT-6   | must     | Each work item (candidate set) is handled in a **fresh, isolated agent session** (empty context) | test:connectAgent.test.ts | ORCH-5; AUTO-2 |
| CONNECT-7   | must     | A canonical node has a **human filename** (`entities/<kind>/<slug>.md`); identity is the stable `id:` (ULID) in frontmatter, with `aliases: [<ULID>, …]` — Connect may rename without breaking lineage | test:connectDoc.test.ts, connectStage.test.ts | DATA-3; (issue #21) |
| CONNECT-8   | must     | A canonical node records **provenance over all contributing sources** (`derivedFrom[]`) and the candidates it consumed (`resolvedFrom[]`) | test:connectDoc.test.ts, connectStage.test.ts | DATA-5 |
| CONNECT-9   | must     | When candidates resolve to an **existing** node, Connect **folds them in** (extends provenance/aliases); it does not create a duplicate | test:connectStage.test.ts | DATA-3; LIFE-3 |
| CONNECT-10  | must     | When two existing nodes are the same thing, Connect picks a **canonical** node, repoints references, and **deletes** the loser (recoverable via git; **no tombstone files**) | test:connectStage.test.ts | DATA-9,11 |
| CONNECT-11  | must     | On merge, affected claims' `subject` is **repointed** to the canonical node and the node's claims block regenerated; **Claims is not re-run** | test:connectStage.test.ts | DATA-5; CLAIMS-9 |
| CONNECT-12  | must     | Connect **promotes** `relatesTo` hints into real Obsidian **`[[wikilinks]]`** in a delimited, regenerated links block, so the graph view connects | test:connectStage.test.ts, connectPipeline.test.ts | DATA-8; LIFE-3; VAULT |
| CONNECT-13  | should   | A link target that cannot be resolved to a canonical node is **not** rendered as a dangling guess — it becomes a `note` signal or a Review | test:connectStage.test.ts | PRIN-4; SCOPE-5 |
| CONNECT-14  | must     | The agent decision is **validated against a schema**; an invalid verdict never loses candidates — the block is flagged and retried, then set aside after K | test:connect.test.ts, connectAgent.test.ts, connectStage.test.ts | ORCH-12; INGEST-8 |
| CONNECT-15  | must     | An **ambiguous** merge/link raises a yes/no **Review** (SPEC-0018) via the decision channel; the affected cluster **parks** (no merge applied) until answered, then resumes with the verdict as context | test:connectStage.test.ts | LIFE-6; AUTO-10; REVIEW-5,6,14 |
| CONNECT-16  | must     | Resolution is **committed per block** and the canonical tree advances only by completed commits via the **serialized canonical writer** | test:connectStage.test.ts | ORCH-3; DATA-9 |
| CONNECT-17  | must     | Connect is **idempotent / restartable**: candidates are marked resolved only in the commit that writes their node; node/claims blocks regenerate whole; crash/re-poke resumes without duplicating | test:connectStage.test.ts | ORCH-4,13 |
| CONNECT-18  | must     | The agent may emit optional **signals** (open `{type, note, refs?}`) routed to the **audit log only**; every run emits append-only audit in the rigid envelope | test:connectStage.test.ts | DATA-10; AUTO-8; ORCH-11 |
| CONNECT-19  | should   | v1 blocks/ resolves **within a single `kind`** and on the **forward pass + re-poke sweep**; cross-kind resolution and continuous recooks/reconcilers are deferred (Reflect-adjacent) | test:connect.test.ts | LIFE-8 |
| CONNECT-20  | should   | v1 links are untyped `[[wikilinks]]` (graph connectivity); a **typed link-as-object** model (predicate + own confidence/evidence) is deferred | **deferred-slice** | DATA-8 |

### CONNECT-3 — entities/ is resolution-only, one writer
- **Status:** draft · **Priority:** must
- **Statement:** Canonical `entities/` **MUST** be written **only** by Connect. Decompose
  **MUST** emit entity **candidates** into the working zone (the `staging` branch; CANON-8)
  and **MUST NOT** write `entities/`. Unresolved, intermediate extraction **MUST NOT** appear
  in the canonical graph the Principal browses (CANON-1/2).
- **Rationale:** Per-source extraction is duplicated and pre-resolution by construction
  (DECOMP-14); letting it into canonical guarantees duplicate nodes and opaque ULID
  filenames (issue #21). Making `entities/` a resolution output with one writer makes every
  canonical node unique, real, and human-named — naming and duplication are the same problem,
  solved at the source.
- **Traces:** DATA-1, LIFE-3
- **Verify:** test:connectStage.test.ts

### CONNECT-4 — deterministic blocking keeps the agent thin
- **Status:** draft · **Priority:** must
- **Statement:** The orchestrator **MUST** group candidates into candidate sets by a
  deterministic block key (`kind` + normalized name) and pass the agent **one** set at a
  time; the agent **MUST NOT** be required to query or hold the whole graph.
- **Rationale:** Entity resolution is inherently cross-item, which threatens the thin-agent
  contract. The blocking/matching split keeps cognition disposable and bounded (the agent
  judges one cluster) while the deterministic orchestrator does the cheap cross-graph scan —
  preserving SPEC-0014's "orchestration deterministic, cognition disposable" exactly.
- **Traces:** ORCH-7
- **Verify:** test:connect.test.ts, connectStage.test.ts

### CONNECT-10 — merge by delete, recoverable via git (no tombstones)
- **Status:** draft · **Priority:** must
- **Statement:** When two existing nodes resolve to one, Connect **MUST** choose a canonical
  node, repoint all references to it, fold the loser's provenance/aliases in, and **delete**
  the loser file. It **MUST NOT** leave tombstone/alias stub files. The deletion is a normal
  tracked git deletion; prior content remains recoverable from history.
- **Rationale:** The Principal's call: tombstone files accrue as cruft in the Obsidian vault
  and graph; git already makes merges reversible and preserves lineage (DATA-11), so a clean
  delete is both tidy and safe. Reversibility comes from version control, not from litter.
- **Traces:** DATA-9, DATA-11
- **Verify:** test:connectStage.test.ts

### CONNECT-12 — links are real Obsidian wikilinks
- **Status:** draft · **Priority:** must
- **Statement:** Connect **MUST** render reconciled relations as real Obsidian
  `[[wikilinks]]` to canonical node paths, inside a delimited, regenerated links block in the
  entity node, so the Obsidian **graph view connects**. Links **MUST** be kept updated as
  nodes merge/rename (regenerated whole). v1 **MUST NOT** require link-as-object files for
  basic connectivity.
- **Rationale:** The Principal's hard requirement: the graph must light up with native
  Obsidian links, not a parallel link store the graph can't see. Regenerate-whole (like the
  claims block) keeps links correct across merges/renames and replay-safe. Rich typed-edge
  metadata, if ever needed, layers on without removing the wikilinks (§7).
- **Traces:** DATA-8, LIFE-3
- **Verify:** test:connectStage.test.ts, connectPipeline.test.ts

### CONNECT-15 — ambiguous merges park for Review, never guess
- **Status:** draft · **Priority:** must
- **Statement:** When the agent is genuinely uncertain whether candidates/nodes are the same
  thing (or whether a link holds), it **MUST** raise a yes/no Review (SPEC-0018) rather than
  guess; the orchestrator **MUST** apply **no** merge for that cluster and park it until
  answered, then resume with the answer as authoritative context. Unambiguous clusters in the
  same set still resolve.
- **Rationale:** A wrong merge conflates two real things — more damaging and less obvious than
  a wrong claim. Gating *irreversible-in-practice* conflation behind a cheap yes/no keeps
  autonomy high where safe (AUTO-1) and asks only where it matters (LIFE-6). Review now exists
  (SPEC-0018), so this is buildable, not deferred.
- **Traces:** LIFE-6, AUTO-10, REVIEW-5, REVIEW-6, REVIEW-14
- **Verify:** test:connectStage.test.ts

## 5. Concurrency & failure model (v1 posture)

Inherits SPEC-0014 §5 / SPEC-0015 §5 / SPEC-0016 §5, with Connect-specific notes:

- **Serial within the stage** (ORCH-6); **pipelined across stages** under the shared
  serialized canonical writer — Connect resolves block A while Decompose extracts source B and
  Claims claims entity Z. Separate worktrees; the canonical-ref advance is the one serialized
  point.
- **Connect is the sole `entities/` writer**, which *removes* a class of cross-stage
  contention: no other stage creates entity nodes, so there is no write-write race on a node's
  identity region. Claims still writes the node's **claims block** (disjoint from Connect's
  identity + links regions) and only after Connect has created the node — a clean downstream
  sequential edit, as in SPEC-0016 §5.
- **Ordering:** because Decompose no longer writes `entities/`, Claims depends on Connect
  having created the node. The derived work-lists already encode this: Claims' queue is
  `entities/` nodes (now written only by Connect), so Claims naturally runs after Connect for
  a given thing. No new coordination primitive needed.
- **Failure contained per block** — a poison candidate set is set aside after K; other blocks
  resolve. Parked (review) blocks wait without blocking others.
- **Replay** — candidates + sources are durable; re-running Connect re-clusters and
  regenerates nodes/links; superseded generations live in git history (LIFE-10, DATA-11).

## 6. The Enrich chain (where this sits)

```
sources/ → Decompose → candidates(on source) → Connect → entities/ (canonical, linked) ← this spec
                                                   │            │
                                                   │            └→ Claims → claims/ + node substance (per entity×source)
                                                   ▼
                                          (RESEARCH, deferred) → secondary sources + corroborated claims (egress; thick agent)
```

- **Decompose** (SPEC-0015, amended): extracts candidates, no longer writes `entities/`.
- **Claims** (SPEC-0016, amended): runs after Connect; work unit becomes (entity × source).
- **Research** (RESEARCH, deferred): external corroboration; egress + thick agent.
- **Reflect** (LIFE-8, deferred): continuous recooks/reconcilers that re-cluster the graph as
  it grows, and collapse duplicate claims — the ongoing counterpart to Connect's forward pass.

## 7. Open questions

- [ ] **Slug collisions** — `entities/<kind>/<slug>.md` collisions within a kind: append a
      short id suffix (drafted) vs. a richer disambiguator. Pin at build time.
- [ ] **Block-key normalization strength** — exact normalized match (v1) misses
      nicknames/acronyms/typos and over-relies on the agent to *merge* across blocks (which it
      can't, since it only sees one block). How aggressive should v1 normalization be, and do
      we need a cross-block "candidate merge" review path? (Likely a later blocking upgrade.)
- [ ] **Typed links** — when do `[[wikilinks]]` graduate to link-as-object files with
      predicate + confidence + evidence (CONNECT-20)? Pin when Query/Explore needs typed edges.
- [ ] **Claims re-pointing vs. re-deriving** — v1 repoints existing claims on merge (§3.6). Is
      there a case where merged context should trigger a Claims re-run? (Deferred to recooks.)
- [ ] **Over-merge correction** — automated un-merge/split if a merge proves wrong; v1 relies
      on git + manual Review correction. (Deferred.)
- [ ] **Cross-kind resolution** — a `person` and an `organization` that are actually the same
      (rare) never merge in v1 (block includes kind). Revisit if it bites.
- [ ] **Retry budget K** — shared with Decompose/Claims; a small constant, tuned on observed
      failure modes.

## 8. Cross-spec amendments (this spec changes shipped stages)

Connect reorders the pipeline, so it amends two merged feature specs — and it is the spec
**SPEC-0019 (CANON) §5 delegates** the entity-graph code-contract amendments to. (CANON owns
the *invariant* and the `staging`-branch decision; SPEC-0020 owns the *code contracts* below;
the DATA edit mirrors CANON onto SPEC-0007.) These amendments are part of this change
(SPECSYS-7); the implementation lands them in the same PR sequence:

- **SPEC-0015 (DECOMP):** DECOMP-1/5 change from "writes entity nodes in `entities/`" to
  "emits entity **candidates** into the working zone (`staging`; CANON-4/8)." Decompose no
  longer writes `entities/`. DECOMP-14 (fresh per-source nodes) becomes "fresh per-source
  **candidates**"; resolution is explicitly Connect's (this spec).
- **SPEC-0016 (CLAIMS):** CLAIMS-5/16 work unit changes from per-**entity** to per-**(entity ×
  source)**, since a resolved node now has many `derivedFrom` sources (resolving SPEC-0016 §7's
  deferred open question). The `claimed` marker becomes keyed by `(entityId, sourceId)`. Claim
  shape (CLAIMS-6) is unchanged — each claim still has one source.
- **SPEC-0007 (DATA):** mirror CANON-1/6 onto the data model — **"canonical `entities/` holds
  resolved output only; identity (`id`) is distinct from filename (human-named)."** Entities
  remain versioned (DATA-3); merges delete losers but git retains lineage (DATA-11).
- **ORCH / staging-branch mission (NOT this spec):** the **promotion-gate mechanics** (stages
  target `staging`; which step advances `main`, and when) are owned by the staging-branch
  implementation per CANON §5 — Connect *assumes* the gate, it does not define it. Flagged so
  the two efforts don't both edit ORCH.

> These are drafted here and must be reflected back into SPEC-0015/0016/0007 (with changelog
> lines) when the implementation lands — not left only in this spec.

## 9. Changelog

- 2026-06-02 — **#136 robustness:** a **blank** `existingNodeId` (and blank `mergeExistingNodeIds`
  entries) in the agent verdict — `""`/whitespace, the agent's way of saying "no existing node to
  fold into" — is now **coerced to absent** in `parseConnectDecision` rather than rejected, so the
  block resolves (born-fresh) instead of failing+set-aside on every attempt and silently stalling.
  Genuinely-malformed values (non-string id) still throw → connectOne's existing failed/set-aside
  path (CONNECT-14/ORCH-12) recovers without wedging. Regression tests: connect.test.ts (parse
  coercion + still-rejects-non-string) + connectStage.test.ts (a real-parse drain with
  `existingNodeId:""` resolves, not set-aside).
- 2026-05-31 — created (draft). Fourth Enrich stage and fourth user of the SPEC-0014 harness;
  the first that reasons across items (blocking + matching). **Sole writer of `entities/`**:
  Decompose emits candidates (amends SPEC-0015), Connect resolves them into canonical,
  human-named, deduped, `[[wikilink]]`-connected nodes; Claims moves to per-(entity × source)
  (amends SPEC-0016); canonical = resolved-only invariant (amends SPEC-0007). Absorbs issue
  #21. Merge by canonical-node + delete-loser (recoverable via git; no tombstones, Principal's
  call); claims repointed not re-run; links are real Obsidian wikilinks (graph must light up);
  ambiguous merges/links park for Review (SPEC-0018, now merged). Deferred: Research,
  typed-link-as-object, cross-kind resolution, continuous recooks/reconcilers, automated
  un-merge.
- 2026-05-31 — **reconciled with SPEC-0019 (CANON), merged after this draft began.** Candidates
  now live in the **working zone (`staging` branch; CANON-8)**, not "on the source / no staging
  tree" — that earlier decision #1 was explicitly **superseded** by CANON §2.2. Added the
  two-zone (`main`/`staging`) + promotion-gate framing (§1.1, §3); pointed the entity-graph
  code-contract amendments at this spec per CANON §5; flagged promotion-gate mechanics as ORCH
  / staging-mission territory. All other Connect decisions unchanged. (Also: merged latest
  `main` to pick up SPEC-0019; resolved the INDEX.md row conflict.)
- 2026-05-31 — **implemented the RESOLVER CORE** (new files `connect.ts`, `connectAgent.ts`,
  `connectDoc.ts`, `connectStage.ts` + tests). Deterministic blocking (kind + normalized name)
  → thin `copilot -p` matching on one candidate set → born-resolved `entities/<kind>/<slug>.md`
  nodes (human filename, `id`/`aliases`, multi-source `derivedFrom`/`resolvedFrom`; CANON-6);
  fold-into-existing, merge-two-nodes (delete loser, no tombstone) + claim `subject` repoint &
  claims-block regen; commit-to-dequeue (candidate files deleted on resolve), retry/set-aside
  after K, ambiguity→Review park (SPEC-0018), signals→audit-only. CONNECT-1..11,14..19
  graduated `Verify: none-yet → test:`. **Link promotion (CONNECT-12/13/20) DEFERRED to a
  follow-up slice** — it consumes Claims' `relatesTo` hints, which require a Connect re-pass
  *after* Claims (the reorder runs Connect first); §3.7 reframed as that slice's target, v1
  writes no links block (SPECSYS-7 — explicit refinement, not silent scope-drop). Scope guard
  (KB-Architect coordination): resolver core only in NEW files; `pipeline.ts` wiring + the
  uniform `branch→staging` retarget are KB-Architect's (the base ref is the single exported
  constant `BASE_BRANCH='main'`, flipped to `staging` on integration). The SPEC-0015/0016/0007
  §8 amendments land with KB-Architect's Decompose→candidates (slice 2) + staging slices, not
  this PR. Full suite green (235 tests).
- 2026-06-02 — **implemented LINK PROMOTION (CONNECT-12/13)** — the "Visible Enrich" slice 3.
  `ConnectStage`'s drain gains a link pass (`readLinkQueue`/`linkOne`) after the candidate pass:
  it reads each canonical node's claims' `relatesTo` hints and resolves them **deterministically**
  (no agent) by normalized name to a canonical node — exactly-one match → a real Obsidian
  `[[entities/<kind>/<slug>]]` link in a delimited, regenerated-WHOLE `kb:links:start/end` block
  (`applyLinksBlock`, mirroring the claims block); zero match → a `note` signal; ambiguous (>1
  same-named entity) → a yes/no Review (CONNECT-15); never a dangling guess (CONNECT-13). Idempotent
  (byte-stable node ⇒ no-op, no churn). Triggered by Claims' `afterDrain` poke (the
  Connect-before-Claims reorder means hints only exist post-Claims) + the sweep backstop; the
  slice-1 promote-hook publishes linked nodes → `main`, so Obsidian's graph view connects.
  CONNECT-12/13 graduated `Verify: deferred-slice → test:`. **CONNECT-15 link-escalation now
  implemented (#13):** an ambiguous hint raises ONE yes/no Review proposing the first deterministic
  match (markerKey `{kind:'link', nodeRel, hint, targetRel}`); the link pass is idempotent — it
  never re-asks an existing hint, renders the link on `confirm`, and declines (→ `note`) on
  `reject`. Resume rides the existing per-drain link pass (the sweep/`afterDrain`-poke re-runs it
  and reads the answered Review — no new resume primitive). **Still deferred:** CONNECT-20
  typed-link-as-object + agent `links[]` consumption — tracked fast-follows.
