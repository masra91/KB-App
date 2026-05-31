---
spec: SPEC-0015
key: CATALOG
title: Decompose & Catalog (Enrich v1)
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0004, SPEC-0006, SPEC-0007, SPEC-0008, SPEC-0013, SPEC-0014]
supersedes: null
stage: Enrich
---

# Decompose & Catalog (Enrich v1)

> The first Enrich stage: read one preserved source and derive the **entity nodes**
> it mentions into the versioned knowledge graph (`entities/`), each linked back to
> the source by provenance. The thinnest honest slice of Enrich — it builds the
> *index* of what exists; the *substance about* those entities (claims), external
> research, and cross-source linking are deliberately later stages it leaves a trail
> for. The second user of the SPEC-0014 orchestration harness.

## 1. Intent (the why / JTBD)

SPEC-0013 (Capture) preserves sources into `sources/` with conservative defaults and
hands each one off for enrichment (CAPTURE-8 / INGEST-6). Until something *reads*
those sources, the KB is an archive, not a second brain — VISION-5/6 ("makes it
better on its own; grounded, connected knowledge") goes unmet.

Lifecycle Stage 2 (Enrich) bundles three capabilities — *Decompose & Catalog ·
Enrich & Research · Connect & Expand* (LIFE-3). This spec owns the **first**: the
**decompose** step of the core loop (SPEC-0003) — turning raw source text into the
**nodes** of the ontology (DATA-3). It is the Enrich-stage analogue of how CAPTURE
was the walking skeleton of Ingest: the smallest end-to-end path that proves
`source → entity → committed graph delta` on the simplest derivation, so every
richer Enrich stage builds on a trusted, **independently-upgradable** base.

It is deliberately a **nodes-only skeleton**. It produces the *index* of entities a
source mentions; it does **not** yet capture the substance *about* them (claims),
research them externally, or resolve "is this the same Steve as last week's." Those
are separate downstream Enrich stages (§6) that this stage hands off to and leaves
**audit-log breadcrumbs** for.

## 2. Scope

**In scope:**
- A **Catalog stage**: one instance of the SPEC-0014 harness (own queue folder, own
  persistent worktree, own versioned instruction file, own model) that drains
  freshly-archived sources serially.
- A **thin (cognition-only) agent** (ORCH-7): given **one** source, it returns a
  structured JSON **decision** listing the entities the source mentions. It is granted
  **no** shell / write / git tools.
- The orchestrator's **deterministic effects**: validate the decision, mint entity
  ids, write `entities/<ULID>.md` nodes with provenance back to the source, emit audit,
  commit the graph delta per source, and advance the canonical tree.
- An **open, emergent** entity-`kind` vocabulary (DATA-6) — base set *nudged* via the
  instruction file, never gated in code.
- An **agent signal channel**: an optional, typed, freeform property-bag the agent can
  emit for the record (notes, ambiguities, taxonomy observations, suggestions) that the
  orchestrator routes to the **audit log only** — never into the KB.
- The **archivist → Catalog handoff** (the Enrich queue) and the **Catalog → next-stage
  seam** (where claims/research/connect will attach).

**Out of scope (for now) — deferred Enrich stages, each its own SPEC-0014 instance:**
- **Claims / attributes layer** — the substance *about* entities ("the Austin site is
  over capacity"), each a derived assertion with status/confidence/evidence. The richer
  half of decompose; a later stage. v1 leaves a `signal` trail where it would help.
- **Enrich & Research** — external lookup to corroborate/expand entities. Involves
  **egress** (AUTO-4) and likely a **thick** agent; a later stage.
- **Connect & Expand** — entity resolution / dedup / merge / alias / typed cross-entity
  links ("which Steve?"). v1 mints **fresh nodes with no resolution**; resolution is a
  later stage, fed partly by `ambiguity` signals and escalating genuine ambiguity to
  **Review** (LIFE-6).
- **Taxonomy curation** — reconciling emergent kinds (`vendor` vs `supplier`); a
  **Reflect** job (LIFE-8), derivable from the distinct `kind` values in `entities/`.
- **Entity `status`** (`fact|interpretation|hypothesis`) — a *claims*-layer concept;
  deferred with claims. v1 nodes carry `confidence` + evidence, not `status`.

## 3. The stage (flow)

Catalog is **the same SPEC-0014 harness as the archivist, with different config** — a
new queue folder + a new instruction file + its own worktree (ORCH-9). Nothing about
the engine changes; this is the reuse the engine was justified by.

```
sources/<…>/<ULID>/source.md   (archived, conservative-classified — SPEC-0013)
   │  archivist pokes the Enrich queue on archive-commit (CAPTURE-8 / ORCH-15)
   ▼
queue/catalog/<ULID>           (durable work item — ORCH-4)
   │  orchestrator drains serially (ORCH-6), in worktree .kb/worktrees/catalog
   ▼
[CATALOG AGENT]  copilot -p, fresh session, no tools (ORCH-5,7)
   in:  the one source's text + metadata
   out: JSON decision { entities[], signals? }
   ▼
ORCHESTRATOR (deterministic effects — ORCH-7):
   ├─ validate decision against schema  (invalid → flag + retry, never lose; ORCH-12)
   ├─ for each entity: mint ULID, write entities/<ULID>.md (provenance → source)
   ├─ append audit events (entities + every signal), envelope-wrapped (ORCH-11)
   ├─ commit the graph delta ("catalog: N entities from <ULID>")
   ├─ serialized fast-forward of canonical tree + refresh root (ORCH-3)
   └─ remove item from queue/catalog/  (only now — commit-to-dequeue; ORCH-4,13)
   ▼
entities/   (versioned ontology nodes — what Query/Explore will later read)
```

### 3.1 The agent decision (the only thing the agent produces)

The agent reads one source and returns **only** this JSON. It writes nothing.

```json
{
  "sourceId": "01JABCDEF7Q2…",
  "entities": [
    {
      "kind": "person",
      "name": "Steve",
      "confidence": 0.9,
      "mentions": ["call Steve re: Q3 budget"]
    },
    {
      "kind": "place",
      "name": "Austin site",
      "confidence": 0.7,
      "mentions": ["the Austin site visit"]
    }
  ],
  "signals": [
    { "type": "note",      "note": "Trip report — a claims pass would capture far more substance." },
    { "type": "ambiguity", "note": "‘Steve’ could be Steve Park or Steve Lin", "refs": ["Steve"] },
    { "type": "taxonomy",  "note": "Coined kind 'site'; may overlap with 'place'." }
  ]
}
```

- **`entities[]`** (required, may be empty): the nodes the source mentions.
  - **`kind`** — an **open string** (DATA-6). Validated only as non-empty. A base set
    (`person, organization, concept, event, place, project`) is **suggested in the
    instruction file** to nudge reuse; the agent **may coin new kinds**. Never gated.
  - **`name`** — the entity's surface name as grounded in the source.
  - **`confidence`** — calibrated belief (0–1) that this is a real, correctly-parsed
    distinct entity (DATA-7). It is the signal a later Review/Connect stage uses to
    route low-confidence nodes (SCOPE-9); v1 does not itself gate on it.
  - **`mentions[]`** — verbatim span(s) from the source that evidence the entity
    (DATA-7 evidence; the agent must not invent entities ungrounded in the text).
- **`signals[]`** (optional, usually absent): the agent's escape hatch — see §3.3.

### 3.2 The entity node (what the orchestrator writes)

One file per entity, deterministic template, **orchestrator-authored** (the agent
never writes it). `entities/` layout mirrors the date-shard convention or a flat
scheme — *physical layout is architecture; pinned at build time*.

```markdown
---
id: 01JABCG9…                       # orchestrator-minted ULID (not the agent's)
kind: person                        # open string, verbatim from the decision
name: Steve
confidence: 0.9
provenance:                         # DATA-5: derived-from + transforming agent
  derivedFrom: [sources/2026/05/30/01JABCDEF7Q2…]
  transformedBy: "catalog · copilot session 01JABD…"
  mentions: ["call Steve re: Q3 budget"]
createdAt: 2026-05-30T18:25:00Z
---

# Steve
```

- **No `status` field** in v1 (deferred with claims).
- v1 mints a **fresh node every time** — no dedup/merge across sources (deferred to
  Connect). Two sources mentioning "Steve" produce two nodes, each with its own
  `derivedFrom`. This is expected and acceptable for the skeleton.

### 3.3 Signals — the agent's structured-freeform channel to the record

A **signal** is the single mechanism by which the agent puts something *on the record*
that is **not** an entity: a free-form note, a flagged ambiguity, a taxonomy
observation, a suggestion for a later stage. Its destination is the **audit log**
(DATA-10, AUTO-8: "the *why*; thought/intent; a superset of the KB") — **never** the
entity graph and **never** the immutable source.

- Shape: `{ type: <open string>, note: <free text, required>, refs?: [<string>] }`.
- **`type`** is an **open vocabulary**, exactly like `kind`: a base set is suggested in
  the instruction file (`note, ambiguity, possible-duplicate, taxonomy, suggestion,
  low-quality-source`) to nudge consistency; the agent may coin others. Never gated.
- **`note`** is the freeform payload; **`refs`** optionally points at entity names /
  mentions the signal is about.
- **Fully optional and usually empty.** Most clean sources warrant no signals; the
  channel must not pressure commentary on every run (that is just bloat).
- Signals carry **no knowledge into the KB**. They are breadcrumbs for *us* and for
  later stages (Connect reads `ambiguity`; Reflect reads `taxonomy`) — the feedback
  channel from agents back toward eventual improvement.

### 3.4 The audit envelope (structure around the freeform)

The agent never writes the log. The orchestrator wraps each entity write and each
signal in a **rigid, code-generated envelope** and appends JSONL, colocated with the
item (ORCH-11). Structure lives in the envelope; freedom lives in the payload.

```jsonl
{"ts":"2026-05-30T18:25:01Z","runId":"01JABD…","stage":"catalog","sourceId":"01JABCDEF7Q2…","model":"…","event":"start"}
{"ts":"2026-05-30T18:25:01Z","runId":"01JABD…","stage":"catalog","sourceId":"01JABCDEF7Q2…","model":"…","event":"signal","type":"ambiguity","note":"‘Steve’ could be Steve Park or Steve Lin","refs":["Steve"]}
{"ts":"2026-05-30T18:25:01Z","runId":"01JABD…","stage":"catalog","sourceId":"01JABCDEF7Q2…","model":"…","event":"committed","commit":"a1b2c3","entities":2}
```

Envelope fields (rigid, orchestrator-owned): `ts, runId, stage, sourceId, model,
event`. Payload fields (per `event`): the entity ids/commit on `committed`; the
agent's `type/note/refs` on `signal`. This is the correlation/timestamp/run-id
structure that keeps the log queryable even though signal content is freeform.

### 3.5 Edge flows (failure tolerance)

- **Malformed / invalid decision** — the source stays in `queue/catalog/`, the failure
  is audited, and the item is retried; after **K** failed attempts it is **flagged and
  set aside** (it does not head-of-line-block the serial queue) — never dropped
  (ORCH-12). The agent cannot half-write anything because it has no write tools.
- **Crash mid-catalog** — the item is still in the queue (it leaves only after the
  commit); on restart the orchestrator re-reads and re-catalogs. Idempotent (ORCH-13).
  Because entity ids are minted fresh and committed atomically per source, a
  re-run after a crash-before-commit produces no orphaned partial nodes.
- **Empty result** — a source the agent finds no entities in commits **zero** nodes
  (optionally a `note` signal) and dequeues cleanly; this is a valid outcome.
- **Window closed** — Catalog runs headless on the orchestrator like every stage
  (ORCH-1).

## 4. Requirements

| ID         | Priority | Statement (short)                                                  | Verify   | Traces |
| ---------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| CATALOG-1  | must     | A Catalog stage drains freshly-archived sources and derives the **entity nodes** each mentions into `entities/` | none-yet | LIFE-3; VISION-5 |
| CATALOG-2  | must     | Catalog is **one instance of the SPEC-0014 harness** (own queue folder, own worktree, own instruction file/model); the engine is reused unchanged | none-yet | ORCH-9 |
| CATALOG-3  | must     | The Catalog agent is **thin / cognition-only**: it returns a structured decision and is granted **no** shell/write/git tools; the orchestrator performs all effects | none-yet | ORCH-7; AUTO-3 |
| CATALOG-4  | must     | Each work item is handled in a **fresh, isolated agent session** (one source, empty context) | none-yet | ORCH-5; AUTO-2 |
| CATALOG-5  | must     | Each derived entity is written as a versioned node in `entities/` with **provenance** (`derivedFrom` → source, transforming agent) and evidence (`mentions`) | none-yet | DATA-3,5,7 |
| CATALOG-6  | must     | The agent decision is **validated against a schema**; an invalid decision never loses or corrupts the source — it is flagged and retried, then set aside after K attempts | none-yet | ORCH-12; INGEST-8 |
| CATALOG-7  | must     | Entity **`kind` is an open, emergent vocabulary** — validated only as a non-empty string; the base set is suggested in the instruction file, **never gated in code** | none-yet | DATA-6 |
| CATALOG-8  | must     | Sources are **never mutated**; Catalog only *derives* — the immutable source remains the ground truth the entity links back to | none-yet | DATA-2; LIFE-2 |
| CATALOG-9  | must     | The agent may emit optional **signals** (typed freeform `{type, note, refs?}`) routed to the **audit log only**, never into the KB | none-yet | DATA-10; AUTO-8 |
| CATALOG-10 | must     | Signal `type` is an **open vocabulary** (base set suggested, not gated); signals are **optional and usually absent** | none-yet | DATA-6; AUTO-8 |
| CATALOG-11 | must     | Every Catalog run **emits append-only audit events** in a rigid orchestrator-owned **envelope** (ts, runId, stage, sourceId, model, event) wrapping freeform payloads | none-yet | ORCH-11; DATA-10 |
| CATALOG-12 | must     | The graph delta is **committed per source** and the canonical tree advances only by completed commits (via the serialized writer) | none-yet | ORCH-3; DATA-9 |
| CATALOG-13 | must     | Catalog is **idempotent / restartable**: an item leaves `queue/catalog/` only after its result is committed; crash/re-poke resumes without duplicating committed work | none-yet | ORCH-4,13 |
| CATALOG-14 | should   | v1 mints **fresh nodes with no cross-source resolution**; dedup/merge/linking ("which Steve?") is deferred to Connect and fed by `ambiguity` signals | none-yet | DATA-3; LIFE-6 |
| CATALOG-15 | must     | v1 entity nodes carry **`confidence` + evidence** but **not `status`**; per-claim epistemics and `status` are deferred with the claims stage | none-yet | DATA-7 |
| CATALOG-16 | should   | The archivist→Catalog handoff and the Catalog→next-stage **seam are queue folders** (poke on commit + periodic sweep): later Enrich stages attach with no change to this stage | none-yet | ORCH-9,15; INGEST-6 |

### CATALOG-3 — Thin agent in v1
- **Status:** draft · **Priority:** must
- **Statement:** The Catalog agent session **MUST** be cognition-only — it returns a
  validated JSON decision; the orchestrator mints ids, writes entity files, emits
  audit, and commits. The agent **MUST NOT** be granted shell/write/git tools.
- **Rationale:** Keeps the commit shape — which *is* the audit substrate (DATA-10) —
  deterministic and testable, fences the LLM's non-determinism inside one validated
  object, and proves the SPEC-0014 reuse claim (ORCH-9) without forking the harness
  contract on its second use. Thick agents arrive when research/tool-use earns its
  keep (Enrich & Research), not preemptively.
- **Traces:** ORCH-7, AUTO-3
- **Verify:** none-yet

### CATALOG-7 — Open, emergent entity kinds
- **Status:** draft · **Priority:** must
- **Statement:** Entity `kind` **MUST** be an open string validated only as non-empty.
  A base set (`person, organization, concept, event, place, project`) **MUST** be
  expressed as guidance in the versioned instruction file to nudge reuse, and **MUST
  NOT** be enforced as a closed set in code.
- **Rationale:** DATA-6 — kinds are open, extensible, emergent, agent-curated. Gating
  them in code would freeze a taxonomy the material itself is meant to grow; nudging in
  prose keeps the graph consistent without caging it, and lets the set evolve as config.
- **Traces:** DATA-6
- **Verify:** none-yet

### CATALOG-8 — Derive, never mutate the source
- **Status:** draft · **Priority:** must
- **Statement:** Catalog **MUST NOT** edit, move, or empty the source. It produces a
  *second representation* (entity nodes) that **links back** to the immutable source;
  the source remains whole, forever.
- **Rationale:** Sources are immutable ground truth (DATA-2); the trust and Replay
  model (LIFE-10) depend on the original existing untouched so any derived node can be
  re-derived or doubted against it. "Lifting out" content would break this.
- **Traces:** DATA-2, LIFE-2
- **Verify:** none-yet

### CATALOG-9 — Signals go to the audit log, not the KB
- **Status:** draft · **Priority:** must
- **Statement:** The agent **MAY** emit `signals` — typed freeform property-bags — which
  the orchestrator **MUST** route to the append-only audit log only, and **MUST NOT**
  write into entity nodes or the source.
- **Rationale:** The audit log is explicitly the home of agent thought/intent and a
  superset of the KB (DATA-10, AUTO-8). Signals are breadcrumbs for later stages
  (Connect reads `ambiguity`, Reflect reads `taxonomy`) and for spec authors — a
  feedback channel toward improvement — not knowledge to be queried as ontology.
- **Traces:** DATA-10, AUTO-8
- **Verify:** none-yet

### CATALOG-13 — Idempotent, commit-to-dequeue
- **Status:** draft · **Priority:** must
- **Statement:** A source **MUST** remain in `queue/catalog/` until its derived nodes
  are committed; restart or re-poke **MUST** resume from queue state without
  duplicating already-committed work.
- **Rationale:** The queue folder is the durable "what's left" (ORCH-4); making the
  commit the dequeue boundary makes crash-recovery free and keeps the canonical graph
  free of orphaned partial nodes.
- **Traces:** ORCH-4, ORCH-13
- **Verify:** none-yet

## 5. Concurrency & failure model (v1 posture)

Stated explicitly because the multi-stage Enrich chain is where it bites (SPEC-0014
deferred parallelism; DATA-§8 left git-concurrency open):

- **Serial within a stage** (ORCH-6) — Catalog drains one source at a time; conflict-
  freedom comes from globally-unique ids.
- **Stages may pipeline across each other** — Catalog, and later Claims/Research/
  Connect, are *separate loops with separate queues and separate worktrees*, so while
  Catalog works source B, a later stage can work source A. This is free, safe
  parallelism (no shared mutable state between worktrees).
- **The canonical advance is serialized** — the one shared resource is the canonical
  git ref. All stages do their work concurrently in their own worktrees, but the final
  "fast-forward canonical + refresh root" step **MUST** go through a single serialized
  writer so commits land one at a time (resolves the SPEC-0014 / DATA-§8 open question
  for v1; full concurrency/DAG stays deferred).
- **Failure is contained per stage** — because each stage dequeues only on commit, a
  downstream crash never loses or redoes upstream work (Catalog's entities are already
  committed when a later stage runs). A poison item is flagged and set aside after K
  attempts rather than head-of-line-blocking its serial queue (ORCH-12).
- **Replay falls out for free** — source immutability + "read input → derive → commit"
  means any stage can be re-run over old sources later (better model, new derivations)
  by re-enqueuing items (LIFE-10).

## 6. The Enrich chain (where this hands off)

Catalog is stage 1 of a chain; each later capability is **its own SPEC-0014 instance**
(own queue, worktree, instruction file, model — therefore independently upgradable and
replayable). The seam between every stage is a **queue folder + poke** (CATALOG-16);
nothing built here changes when these attach:

```
sources/ ─poke→ queue/catalog/ ─[CATALOG]→ entities/ (nodes)            ← this spec
                                   │ poke
                                   ▼
                 queue/claims/   ─[CLAIMS]→ entities/ decorated w/ claims (substance, status, evidence)   ← deferred
                                   │ poke
                                   ▼
                 queue/research/ ─[RESEARCH]→ secondary sources + corroborated attrs (egress; thick agent) ← deferred
                                   │ poke
                                   ▼
                 queue/connect/  ─[CONNECT]→ entity resolution / merge / typed links ("which Steve?")      ← deferred
```

- **Claims** captures the *substance about* entities (the trip-report content): each a
  derived assertion with `status` + `confidence` + evidence. This is the half that
  makes an entity page *say something*; v1 leaves `note` signals where it would help.
- **Research** corroborates/expands externally (AUTO-4 egress; likely thick agent).
- **Connect** resolves identity across sources (dedup/merge/alias/typed links), fed by
  Catalog's `ambiguity` signals, escalating genuine ambiguity to **Review** (LIFE-6).
- **Reflect** (cross-cutting, LIFE-8) curates the emergent `kind`/`type` taxonomies,
  reading the distinct values in `entities/` and `taxonomy` signals.

## 7. Open questions

- [ ] **`entities/` physical layout** *(architecture)* — date-shard like `sources/`,
      flat, or kind-partitioned? Pin at build time; does not affect requirements.
- [ ] **Retry budget K** — how many failed attempts before an item is flagged and set
      aside? (A small constant; tune once real failure modes are observed.)
- [ ] **Confidence calibration** — is the agent's self-reported `confidence` trustworthy
      enough to drive later Review routing, or does it need calibration/normalization?
      (Revisit when Review is specced.)
- [ ] **Source size / chunking** — very large sources may exceed a single agent context;
      does Catalog chunk a source and union the entities, or defer large-source handling?
      (Parallels SPEC-0013's parked large/binary question.)
- [ ] **Instruction-file versioning surface** — the base `kind`/`type` sets live in the
      versioned prompt template (SPEC-0014); how are template versions stamped into the
      audit envelope so replays are attributable to a prompt generation? (Architecture.)
- [ ] **Catalog vs. Claims boundary** — confirmed split for v1 (nodes now, substance
      later); revisit whether a light always-on summary belongs with Catalog or strictly
      with Claims once Claims is specced.

## 8. Changelog

- 2026-05-30 — created (draft). First Enrich stage and second user of the SPEC-0014
  harness. Nodes-only skeleton: archived source → thin cognition-only Catalog agent →
  validated entity decision → orchestrator-written `entities/` nodes with provenance →
  committed graph delta. Open emergent `kind` vocabulary (nudged, not gated); optional
  typed-freeform `signals` routed to the audit log only via a rigid orchestrator
  envelope. Deferred (each a later SPEC-0014 stage off the queue seam): claims/
  attributes layer + `status`, external research (egress/thick agent), entity
  resolution/linking ("which Steve?"), and taxonomy curation (Reflect). Pinned the v1
  concurrency posture (serial-in-stage, pipelined-across-stages, serialized canonical
  writer) and per-stage commit-to-dequeue failure containment.
