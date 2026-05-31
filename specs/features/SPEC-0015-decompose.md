---
spec: SPEC-0015
key: DECOMP
title: Decompose (Enrich v1)
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0003, SPEC-0004, SPEC-0006, SPEC-0007, SPEC-0008, SPEC-0013, SPEC-0014]
supersedes: null
stage: Enrich
---

# Decompose (Enrich v1)

> The first Enrich stage: read one preserved source and **decompose** it into the
> **entity nodes** it mentions, written into the versioned knowledge graph
> (`entities/`), each linked back to the source by provenance. The thinnest honest
> slice of Enrich — it builds the *index* of what exists; the *substance about* those
> entities (claims), external research, and cross-source linking are deliberately
> later stages it leaves a trail for. The second user of the SPEC-0014 orchestration
> harness.

## 1. Intent (the why / JTBD)

SPEC-0013 (Capture) preserves sources into `sources/` with conservative classification
and hands each one off for enrichment (CAPTURE-8 / INGEST-6). Until something *reads*
those sources and develops understanding, the KB is an archive, not a second brain —
VISION-5/6 ("makes it better on its own; grounded, connected knowledge") goes unmet.

Lifecycle Stage 2 (Enrich) bundles three capabilities — *Decompose & Catalog ·
Enrich & Research · Connect & Expand* (LIFE-3). This spec owns the **decompose** step
of the core loop (SPEC-0003): turning raw source text into the **nodes** of the
ontology (DATA-3). It is the Enrich-stage analogue of how CAPTURE was the walking
skeleton of Ingest: the smallest end-to-end path that proves `source → entity →
committed graph delta` on the simplest derivation, so every richer Enrich stage builds
on a trusted, **independently-upgradable** base.

It is deliberately a **nodes-only skeleton**. It produces the *index* of entities a
source mentions; it does **not** yet capture the substance *about* them (claims),
research them externally, or resolve "is this the same Steve as last week's." Those
are separate downstream Enrich stages (§6) that this stage hands off to and leaves
**audit-log breadcrumbs** for.

### 1.1 Vocabulary — Classify vs. Catalog vs. Decompose (read this first)

These three words name **different steps in different stages** and have been a source
of confusion. Pinned here so the flow is unambiguous:

| Term | Stage | What it does | Operates on | Status |
| ---- | ----- | ------------ | ----------- | ------ |
| **Classify** | **Ingest** | assign **scope + sensitivity** (v1: conservative defaults `global`/`internal`) | the source | ✅ built (archivist, SPEC-0013) |
| **Catalog** | **Ingest** | extract **basic metadata**, write `source.md`, make the source **discoverable** | the source | ✅ built (archivist, SPEC-0013) |
| **Decompose** | **Enrich** | **extract entities** from the source into `entities/` | source → **entities** | 🔲 **this spec** |

The lifecycle (SPEC-0004) names the Enrich capability "Decompose **& Catalog**", but
"catalog" there collides with Ingest's metadata step. **To keep the flow super clear,
this spec and all of its code use only the word `decompose` (key `DECOMP`, stage/queue/
worktree `decompose`) for the entity-extraction job.** "Classify" and "Catalog" mean the
**Ingest** steps and nothing else. *Rich* classification (real scope/sensitivity
inference, beyond today's defaults) is homeless today — deferred by Ingest, not claimed
here; it is noted as a future Enrich stage in §6, not built in v1.

## 2. Scope

**In scope:**
- A **Decompose stage**: one instance of the SPEC-0014 harness (own queue folder, own
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
- The **archivist → Decompose handoff** (the Enrich queue) and the **Decompose →
  next-stage seam** (where claims/research/connect will attach).

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
- **Rich classify** — real scope/sensitivity *inference* (vs. Ingest's v1 defaults);
  deferred by SPEC-0008/0013 and not claimed by v1 Decompose. A candidate later Enrich
  stage (§6).
- **Taxonomy curation** — reconciling emergent kinds (`vendor` vs `supplier`); a
  **Reflect** job (LIFE-8), derivable from the distinct `kind` values in `entities/`.
- **Entity `status`** (`fact|interpretation|hypothesis`) — a *claims*-layer concept;
  deferred with claims. v1 nodes carry `confidence` + evidence, not `status`.

## 3. The stage (flow)

Decompose is **the same SPEC-0014 harness as the archivist, with different config** — a
new queue folder + a new instruction file + its own worktree (ORCH-9). Nothing about
the engine changes; this is the reuse the engine was justified by.

```
INGEST  (archivist — already built, SPEC-0013):
  Arrive → Archive (commit) → Classify (scope/sensitivity) → Catalog (source.md) → Enqueue
                                                                                       │
sources/<…>/<ULID>/source.md   (archived, classified, cataloged)                       │
   │  archivist pokes the Enrich queue on archive-commit (CAPTURE-8 / ORCH-15) ◄───────┘
   ▼
queue/decompose/<ULID>         (durable work item — ORCH-4)
   │  orchestrator drains serially (ORCH-6), in worktree .kb/worktrees/decompose
   ▼
[DECOMPOSE AGENT]  copilot -p, fresh session, no tools (ORCH-5,7)
   in:  the one source's text + metadata
   out: JSON decision { entities[], signals? }
   ▼
ORCHESTRATOR (deterministic effects — ORCH-7):
   ├─ validate decision against schema  (invalid → flag + retry, never lose; ORCH-12)
   ├─ for each entity: mint ULID, write entities/<ULID>.md (provenance → source)
   ├─ append audit events (entities + every signal), envelope-wrapped (ORCH-11)
   ├─ commit the graph delta ("decompose: N entities from <ULID>")
   ├─ serialized fast-forward of canonical tree + refresh root (ORCH-3)
   └─ remove item from queue/decompose/  (only now — commit-to-dequeue; ORCH-4,13)
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
  transformedBy: "decompose · copilot session 01JABD…"
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
{"ts":"2026-05-30T18:25:01Z","runId":"01JABD…","stage":"decompose","sourceId":"01JABCDEF7Q2…","model":"…","event":"start"}
{"ts":"2026-05-30T18:25:01Z","runId":"01JABD…","stage":"decompose","sourceId":"01JABCDEF7Q2…","model":"…","event":"signal","type":"ambiguity","note":"‘Steve’ could be Steve Park or Steve Lin","refs":["Steve"]}
{"ts":"2026-05-30T18:25:01Z","runId":"01JABD…","stage":"decompose","sourceId":"01JABCDEF7Q2…","model":"…","event":"committed","commit":"a1b2c3","entities":2}
```

Envelope fields (rigid, orchestrator-owned): `ts, runId, stage, sourceId, model,
event`. Payload fields (per `event`): the entity ids/commit on `committed`; the
agent's `type/note/refs` on `signal`. This is the correlation/timestamp/run-id
structure that keeps the log queryable even though signal content is freeform.

### 3.5 Edge flows (failure tolerance)

- **Malformed / invalid decision** — the source stays in `queue/decompose/`, the failure
  is audited, and the item is retried; after **K** failed attempts it is **flagged and
  set aside** (it does not head-of-line-block the serial queue) — never dropped
  (ORCH-12). The agent cannot half-write anything because it has no write tools.
- **Crash mid-decompose** — the item is still in the queue (it leaves only after the
  commit); on restart the orchestrator re-reads and re-decomposes. Idempotent (ORCH-13).
  Because entity ids are minted fresh and committed atomically per source, a
  re-run after a crash-before-commit produces no orphaned partial nodes.
- **Empty result** — a source the agent finds no entities in commits **zero** nodes
  (optionally a `note` signal) and dequeues cleanly; this is a valid outcome.
- **Window closed** — Decompose runs headless on the orchestrator like every stage
  (ORCH-1).

## 4. Requirements

| ID         | Priority | Statement (short)                                                  | Verify   | Traces |
| ---------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| DECOMP-1   | must     | A Decompose stage drains freshly-archived sources and derives the **entity nodes** each mentions into `entities/` | test:decomposeStage.test.ts | LIFE-3; VISION-5 |
| DECOMP-2   | must     | Decompose is **one instance of the SPEC-0014 harness** (own queue folder, own worktree, own instruction file/model); the engine is reused unchanged | test:decomposeStage.test.ts | ORCH-9 |
| DECOMP-3   | must     | The Decompose agent is **thin / cognition-only**: it returns a structured decision and is granted **no** shell/write/git tools; the orchestrator performs all effects | test:decomposeAgent.test.ts | ORCH-7; AUTO-3 |
| DECOMP-4   | must     | Each work item is handled in a **fresh, isolated agent session** (one source, empty context) | test:decomposeAgent.test.ts | ORCH-5; AUTO-2 |
| DECOMP-5   | must     | Each derived entity is written as a versioned node in `entities/` with **provenance** (`derivedFrom` → source, transforming agent) and evidence (`mentions`) | test:entityDoc.test.ts, decomposeStage.test.ts | DATA-3,5,7 |
| DECOMP-6   | must     | The agent decision is **validated against a schema**; an invalid decision never loses or corrupts the source — it is flagged and retried, then set aside after K attempts | test:decompose.test.ts, decomposeStage.test.ts | ORCH-12; INGEST-8 |
| DECOMP-7   | must     | Entity **`kind` is an open, emergent vocabulary** — validated only as a non-empty string; the base set is suggested in the instruction file, **never gated in code** | test:decompose.test.ts, decomposeAgent.test.ts | DATA-6 |
| DECOMP-8   | must     | Sources are **never mutated**; Decompose only *derives* — the immutable source remains the ground truth the entity links back to | test:decomposeStage.test.ts | DATA-2; LIFE-2 |
| DECOMP-9   | must     | The agent may emit optional **signals** (typed freeform `{type, note, refs?}`) routed to the **audit log only**, never into the KB | test:decomposeStage.test.ts | DATA-10; AUTO-8 |
| DECOMP-10  | must     | Signal `type` is an **open vocabulary** (base set suggested, not gated); signals are **optional and usually absent** | test:decompose.test.ts | DATA-6; AUTO-8 |
| DECOMP-11  | must     | Every Decompose run **emits append-only audit events** in a rigid orchestrator-owned **envelope** (ts, runId, stage, sourceId, model, event) wrapping freeform payloads | test:decomposeStage.test.ts | ORCH-11; DATA-10 |
| DECOMP-12  | must     | The graph delta is **committed per source** and the canonical tree advances only by completed commits (via the serialized writer) | test:decomposeStage.test.ts | ORCH-3; DATA-9 |
| DECOMP-13  | must     | Decompose is **idempotent / restartable**: an item leaves `queue/decompose/` only after its result is committed; crash/re-poke resumes without duplicating committed work | test:decomposeStage.test.ts | ORCH-4,13 |
| DECOMP-14  | should   | v1 mints **fresh nodes with no cross-source resolution**; dedup/merge/linking ("which Steve?") is deferred to Connect and fed by `ambiguity` signals | test:decomposeStage.test.ts | DATA-3; LIFE-6 |
| DECOMP-15  | must     | v1 entity nodes carry **`confidence` + evidence** but **not `status`**; per-claim epistemics and `status` are deferred with the claims stage | test:entityDoc.test.ts | DATA-7 |
| DECOMP-16  | should   | The archivist→Decompose handoff and the Decompose→next-stage **seam are queue folders** (poke on commit + periodic sweep): later Enrich stages attach with no change to this stage | test:decomposeStage.test.ts | ORCH-9,15; INGEST-6 |

### DECOMP-3 — Thin agent in v1
- **Status:** draft · **Priority:** must
- **Statement:** The Decompose agent session **MUST** be cognition-only — it returns a
  validated JSON decision; the orchestrator mints ids, writes entity files, emits
  audit, and commits. The agent **MUST NOT** be granted shell/write/git tools.
- **Rationale:** Keeps the commit shape — which *is* the audit substrate (DATA-10) —
  deterministic and testable, fences the LLM's non-determinism inside one validated
  object, and proves the SPEC-0014 reuse claim (ORCH-9) without forking the harness
  contract on its second use. Thick agents arrive when research/tool-use earns its
  keep (Enrich & Research), not preemptively.
- **Traces:** ORCH-7, AUTO-3
- **Verify:** test:decomposeAgent.test.ts

### DECOMP-7 — Open, emergent entity kinds
- **Status:** draft · **Priority:** must
- **Statement:** Entity `kind` **MUST** be an open string validated only as non-empty.
  A base set (`person, organization, concept, event, place, project`) **MUST** be
  expressed as guidance in the versioned instruction file to nudge reuse, and **MUST
  NOT** be enforced as a closed set in code.
- **Rationale:** DATA-6 — kinds are open, extensible, emergent, agent-curated. Gating
  them in code would freeze a taxonomy the material itself is meant to grow; nudging in
  prose keeps the graph consistent without caging it, and lets the set evolve as config.
- **Traces:** DATA-6
- **Verify:** test:decompose.test.ts

### DECOMP-8 — Derive, never mutate the source
- **Status:** draft · **Priority:** must
- **Statement:** Decompose **MUST NOT** edit, move, or empty the source. It produces a
  *second representation* (entity nodes) that **links back** to the immutable source;
  the source remains whole, forever.
- **Rationale:** Sources are immutable ground truth (DATA-2); the trust and Replay
  model (LIFE-10) depend on the original existing untouched so any derived node can be
  re-derived or doubted against it. "Lifting out" content would break this.
- **Traces:** DATA-2, LIFE-2
- **Verify:** test:decomposeStage.test.ts

### DECOMP-9 — Signals go to the audit log, not the KB
- **Status:** draft · **Priority:** must
- **Statement:** The agent **MAY** emit `signals` — typed freeform property-bags — which
  the orchestrator **MUST** route to the append-only audit log only, and **MUST NOT**
  write into entity nodes or the source.
- **Rationale:** The audit log is explicitly the home of agent thought/intent and a
  superset of the KB (DATA-10, AUTO-8). Signals are breadcrumbs for later stages
  (Connect reads `ambiguity`, Reflect reads `taxonomy`) and for spec authors — a
  feedback channel toward improvement — not knowledge to be queried as ontology.
- **Traces:** DATA-10, AUTO-8
- **Verify:** test:decomposeStage.test.ts

### DECOMP-13 — Idempotent, commit-to-dequeue
- **Status:** draft · **Priority:** must
- **Statement:** A source **MUST** remain in `queue/decompose/` until its derived nodes
  are committed; restart or re-poke **MUST** resume from queue state without
  duplicating already-committed work.
- **Rationale:** The queue folder is the durable "what's left" (ORCH-4); making the
  commit the dequeue boundary makes crash-recovery free and keeps the canonical graph
  free of orphaned partial nodes.
- **Traces:** ORCH-4, ORCH-13
- **Verify:** test:decomposeStage.test.ts

## 5. Concurrency & failure model (v1 posture)

Stated explicitly because the multi-stage Enrich chain is where it bites (SPEC-0014
deferred parallelism; DATA-§8 left git-concurrency open):

- **Serial within a stage** (ORCH-6) — Decompose drains one source at a time; conflict-
  freedom comes from globally-unique ids.
- **Stages may pipeline across each other** — Decompose, and later Claims/Research/
  Connect, are *separate loops with separate queues and separate worktrees*, so while
  Decompose works source B, a later stage can work source A. This is free, safe
  parallelism (no shared mutable state between worktrees).
- **The canonical advance is serialized** — the one shared resource is the canonical
  git ref. All stages do their work concurrently in their own worktrees, but the final
  "fast-forward canonical + refresh root" step **MUST** go through a single serialized
  writer so commits land one at a time (resolves the SPEC-0014 / DATA-§8 open question
  for v1; full concurrency/DAG stays deferred).
- **Failure is contained per stage** — because each stage dequeues only on commit, a
  downstream crash never loses or redoes upstream work (Decompose's entities are already
  committed when a later stage runs). A poison item is flagged and set aside after K
  attempts rather than head-of-line-blocking its serial queue (ORCH-12).
- **Replay falls out for free** — source immutability + "read input → derive → commit"
  means any stage can be re-run over old sources later (better model, new derivations)
  by re-enqueuing items (LIFE-10).

## 6. The Enrich chain (where this hands off)

Decompose is stage 1 of a chain; each later capability is **its own SPEC-0014 instance**
(own queue, worktree, instruction file, model — therefore independently upgradable and
replayable). The seam between every stage is a **queue folder + poke** (DECOMP-16);
nothing built here changes when these attach:

```
sources/ ─poke→ queue/decompose/ ─[DECOMPOSE]→ entities/ (nodes)            ← this spec
                                    │ poke
                                    ▼
                 queue/claims/    ─[CLAIMS]→ entities/ decorated w/ claims (substance, status, evidence)  ← deferred
                                    │ poke
                                    ▼
                 queue/research/  ─[RESEARCH]→ secondary sources + corroborated attrs (egress; thick agent) ← deferred
                                    │ poke
                                    ▼
                 queue/connect/   ─[CONNECT]→ entity resolution / merge / typed links ("which Steve?")      ← deferred
```

- **Claims** captures the *substance about* entities (the trip-report content): each a
  derived assertion with `status` + `confidence` + evidence. This is the half that
  makes an entity page *say something*; v1 leaves `note` signals where it would help.
- **Research** corroborates/expands externally (AUTO-4 egress; likely thick agent).
- **Connect** resolves identity across sources (dedup/merge/alias/typed links), fed by
  Decompose's `ambiguity` signals, escalating genuine ambiguity to **Review** (LIFE-6).
- **Rich classify** — real scope/sensitivity *inference* beyond Ingest's v1 defaults —
  is a candidate later stage off this same seam (deferred by Ingest, not claimed in v1).
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
      does Decompose chunk a source and union the entities, or defer large-source
      handling? (Parallels SPEC-0013's parked large/binary question.)
- [ ] **Instruction-file versioning surface** — the base `kind`/`type` sets live in the
      versioned prompt template (SPEC-0014); how are template versions stamped into the
      audit envelope so replays are attributable to a prompt generation? (Architecture.)
- [ ] **Decompose vs. Claims boundary** — confirmed split for v1 (nodes now, substance
      later); revisit whether a light always-on summary belongs with Decompose or
      strictly with Claims once Claims is specced.

## 8. Changelog

- 2026-05-30 — created (draft) as "Decompose & Catalog (key CATALOG)". First Enrich
  stage and second user of the SPEC-0014 harness. Nodes-only skeleton: archived source
  → thin cognition-only agent → validated entity decision → orchestrator-written
  `entities/` nodes with provenance → committed graph delta. Open emergent `kind`
  vocabulary (nudged, not gated); optional typed-freeform `signals` routed to the audit
  log only via a rigid orchestrator envelope. Deferred (each a later SPEC-0014 stage off
  the queue seam): claims/attributes layer + `status`, external research (egress/thick
  agent), entity resolution/linking, taxonomy curation. Pinned the v1 concurrency
  posture (serial-in-stage, pipelined-across-stages, serialized canonical writer) and
  per-stage commit-to-dequeue failure containment.
- 2026-05-30 — **renamed to "Decompose (Enrich v1)", key CATALOG → DECOMP**, stage/
  queue/worktree → `decompose`, requirement IDs CATALOG-N → DECOMP-N. Reason: "catalog"
  collided with the Ingest **Catalog** step (source-metadata registration). Added §1.1
  pinning the **Classify / Catalog / Decompose** vocabulary (Classify + Catalog are
  Ingest steps, already built; Decompose is this Enrich stage). Added **rich classify**
  (scope/sensitivity inference) to the deferred list / Enrich chain (§6) — homeless
  after Ingest deferred it; not built in v1.
- 2026-05-30 — **implemented.** Built on the existing SPEC-0014 harness (archivist #7/#8,
  ORCH-16 #10): extracted the canonical-writer `Mutex` into a shared `stageLock` injected
  into both the archivist and the new Decompose stage (§5 serialized writer); added the
  thin `copilot -p` Decompose decider + versioned prompt (open `kind`/`type` nudged in
  prose, never gated), the decision schema/validation, the `entities/<ULID>.md` writer
  (provenance, confidence, no `status`), and the stage runtime (own `decompose` worktree,
  derived sources-sweep queue, commit-to-dequeue, retry/set-aside after K, signals→audit
  only). v1 handoff is a `sources/` sweep (the archivist does not yet enqueue an Enrich
  queue; DECOMP-16). All `must` requirements graduated `Verify: none-yet → test:` with
  requirement-traced tests (DECOMP-1..16 + ORCH-); the injected decider keeps CI
  credential-free.
