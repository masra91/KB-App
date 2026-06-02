---
spec: SPEC-0016
key: CLAIMS
title: Claims (Enrich v2)
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0003, SPEC-0004, SPEC-0006, SPEC-0007, SPEC-0008, SPEC-0013, SPEC-0014, SPEC-0015]
supersedes: null
stage: Enrich
---

# Claims (Enrich v2)

> The second Enrich stage: read **one entity node and the whole source it was derived
> from**, and derive the **claims** that source makes *about* that entity — each a
> versioned assertion carrying `status` / `confidence` / `evidence`, written into
> `claims/` and back-linked from the entity. Decompose built the *index of what
> exists*; Claims gives each node **substance** — it makes an entity page finally *say
> something*. The third user of the SPEC-0014 orchestration harness.

## 1. Intent (the why / JTBD)

SPEC-0015 (Decompose) turns a preserved source into the **entity nodes** it mentions —
the *index* of the ontology. But a node is just a name with provenance; until something
reads the source and records *what is asserted about* that entity, the KB knows Steve
*exists* but nothing he *did*. VISION-5/6 ("grounded, connected knowledge that makes
itself better") needs the substance, not just the skeleton.

Lifecycle Stage 2 (Enrich) bundles three capabilities — *Decompose & Catalog · Enrich
& Research · Connect & Expand* (LIFE-3). Decompose owned the *nodes*; **Claims owns the
internal substance** — the assertions a source already contains, extracted with no
external lookup. It is the Enrich-stage analogue of how Decompose was the walking
skeleton of nodes: the smallest end-to-end path that proves `entity + source → claim →
committed graph delta`, so every richer Enrich stage (external Research, cross-source
Connect) builds on a trusted, **independently-upgradable** base.

Claims is deliberately **internal-only**. It records what *this one source* says about
*this one entity*. It does **not** corroborate against the outside world (that is
Research — egress, AUTO-4, a thick agent), and it does **not** reconcile identity or
establish typed relations across sources (that is Connect). Claims is the last
zero-egress, thin-agent Enrich stage — the natural next slice to build in parallel with
Decompose, attaching at the existing queue seam (DECOMP-16) with no change to Decompose.

It is also where a deferred epistemic question finally lands: SPEC-0007 §8 left "do
status/confidence/evidence attach at the **entity** or the **claim** level?" open, "to
pin when Enrich is specced," and DECOMP-15 deferred entity `status` "with the claims
stage." **This spec resolves it: `status` (fact/interpretation/hypothesis) is a
per-claim attribute; entity nodes keep `confidence` + evidence and stay status-free.**

### 1.1 Vocabulary — Node vs. Claim vs. Link (read this first)

Pinned to keep the chain unambiguous, extending SPEC-0015 §1.1:

| Term | Stage | What it is | Operates on | Status |
| ---- | ----- | ---------- | ----------- | ------ |
| **Node** (entity) | **Decompose** | a *thing the source mentions* (the index): `kind` + `name` + provenance | source → **entities** | 🔲 SPEC-0015 |
| **Claim** | **Claims** | an *assertion a source makes about a node*: statement + `status` + `confidence` + evidence | entity + its source → **claims** | 🔲 **this spec** |
| **Link** (typed edge) | **Connect** | an *established, reconciled relation between nodes* across sources ("Steve → manages → Austin") | entities → **typed links** | 🔲 deferred |

The dividing lines this spec defends:
- **Node vs. Claim** — a node says *Steve exists (per source X)*; a claim says *source X
  asserts Steve owns the Q3 budget*. Nodes are nouns; claims are sentences.
- **Claim vs. Link** — a claim is **single-subject** and lives entirely within one
  source's testimony. A claim *may mention* another entity in its prose (or carry a soft
  `relatesTo` hint), but it **does not establish a typed relation** — that is Connect's
  job, performed across sources with identity resolution (§3.3, CLAIMS-10). Claims state
  *what one source says*; Connect reconciles *what is true across sources*.

## 2. Scope

**In scope:**
- A **Claims stage**: one instance of the SPEC-0014 harness (own `queue/claims/`, own
  persistent worktree, own versioned instruction file, own model) that drains entities
  serially.
- A **thin (cognition-only) agent** (ORCH-7): given **one entity node + the whole source
  it was derived from**, it returns a structured JSON **decision** listing the claims that
  source makes about that entity. Granted **no** shell / write / git tools.
- The orchestrator's **deterministic effects**: validate the decision, mint claim ids,
  write `claims/<ULID>` files (provenance → source, subject → entity), **regenerate the
  entity node's delimited "claims" block** (the hybrid back-link), emit audit, commit the
  graph delta per entity, advance the canonical tree.
- **Per-claim epistemics**: `status` ∈ `{fact, interpretation, hypothesis}` (a **closed**
  set, unlike open `kind`), `confidence` (0–1), and `evidence` (whole source +
  corroborating mention spans). **This stage is where `status` lands.**
- A **soft, unresolved `relatesTo` hint** on a claim (entity names/mentions its statement
  touches) — a breadcrumb for **Connect**, explicitly **not** an established link.
- Reuse of the **signal channel** (DECOMP-9): optional typed-freeform `{type, note, refs?}`
  routed to the **audit log only**, never the KB.
- The **Decompose → Claims handoff** (the claims queue, keyed by entity) and the **Claims
  → next-stage seam** (where Research / Connect attach).

**Out of scope (for now) — deferred Enrich stages, each its own SPEC-0014 instance:**
- **Enrich & Research** — external lookup to corroborate/expand claims. Involves **egress**
  (AUTO-4) and a likely **thick** agent; a later stage. v1 records only internal assertions
  and leaves `note`/`suggestion` signals where research would help.
- **Connect & Expand** — entity resolution / dedup / merge / alias, and the **establishment
  of typed cross-entity links** from claim prose + `relatesTo` hints. v1 mints claims
  against the per-source fresh node and never links across sources; fed partly by
  `relatesTo` and `possible-duplicate` signals, escalating genuine ambiguity to **Review**
  (LIFE-6).
- **Cross-_source_ dedup** — two **different sources** asserting the same thing produce two
  claims (each with its own provenance). Cross-source merging stays a Connect/Reflect concern.
  (**Within-source** near-duplicate collapse is now *in* scope — see **CLAIMS-19** — performed
  by Connect's post-Claims pass; it groups strictly by source provenance, so it never touches
  cross-source claims.)
- **Claim retraction / supersession logic** — when a newer source contradicts an older
  claim. v1 records both; conflict surfacing is a Connect/Review concern (claims carry
  `status` + `confidence`, the raw material for it, but no resolution policy here).
- **Rich classify** — scope/sensitivity *inference* on derived knowledge; still deferred
  (SPEC-0015 §6), not claimed here.

## 3. The stage (flow)

Claims is **the same SPEC-0014 harness as the archivist and Decompose, with different
config** — a new queue folder + a new instruction file + its own worktree (ORCH-9). The
engine does not change; this is the third proof of the reuse it was justified by.

The **work unit is an entity** (the Principal's call). Because v1 Decompose mints a
**fresh node per source** (DECOMP-14), every entity has exactly **one** `derivedFrom`
source — so "this entity and its source" is unambiguous in v1. (§7 notes what shifts once
Connect merges nodes that share a name across sources.)

> **v1 implementation note (matches the merged code).** Like Decompose, there is **no
> `queue/` folder yet** — the durable work list is **derived**: Claims sweeps `entities/`
> and an entity is "queued" until a terminal `{stage:"claims", event:"claimed", entityId}`
> marker exists. That marker (and all Claims audit) is appended to the entity's **source
> `audit.jsonl`** — keyed by `entityId`, reusing the per-source audit Decompose already
> writes rather than inventing per-entity audit files. Committing the claim files + the
> regenerated node block + the `claimed` marker in **one commit** is the commit-to-dequeue.
> The `queue/claims/` folder + per-entity poke below is the eventual contract (DECOMP-16 /
> CLAIMS-18); the diagram shows that target shape. Physical layout: claim files are
> `claims/<dateShard(id)>/<id>.md`, mirroring `entities/`.

```
DECOMPOSE (SPEC-0015) commits entities/<E> from a source, then pokes the claims queue
   per minted entity (DECOMP-16 / ORCH-15) ─────────────────────────────────────────┐
                                                                                      ▼
queue/claims/<entityULID>        (durable work item — ORCH-4)
   │  orchestrator drains serially (ORCH-6), in worktree .kb/.../worktrees/claims
   ▼
[CLAIMS AGENT]  copilot -p, fresh session, no tools (ORCH-5,7)
   in:  one entity node (entities/<E>.md)  +  the WHOLE source it derives from
   out: JSON decision { entityId, claims[], signals? }
   ▼
ORCHESTRATOR (deterministic effects — ORCH-7):
   ├─ validate decision against schema  (invalid → flag + retry, never lose; ORCH-12)
   ├─ for each claim: mint ULID, write claims/<C> (subject → <E>, evidence → source)
   ├─ regenerate the delimited "claims" block inside entities/<E>.md (idempotent)
   ├─ append audit events (claims + every signal), envelope-wrapped (ORCH-11)
   ├─ commit the graph delta ("claims: N about <E> from <source>")
   ├─ serialized fast-forward of canonical tree + refresh root (ORCH-3)
   └─ remove item from queue/claims/  (only now — commit-to-dequeue; ORCH-4,13)
   ▼
claims/   (versioned assertions)   +   entities/<E>.md  (now shows its substance)
```

### 3.1 The agent decision (the only thing the agent produces)

The agent reads **one entity node and the whole source** and returns **only** this JSON.
It writes nothing. It does not mint claim ids and does not restate the subject (the
subject is the queue-item entity).

```json
{
  "entityId": "01JABCG9…",
  "claims": [
    {
      "statement": "Owns the Q3 budget.",
      "status": "interpretation",
      "confidence": 0.7,
      "mentions": ["Steve owns the Q3 budget line"],
      "relatesTo": ["Austin site"]
    },
    {
      "statement": "Attended the Austin site visit on May 14.",
      "status": "fact",
      "confidence": 0.95,
      "mentions": ["Steve was at the Austin site on the 14th"]
    }
  ],
  "signals": [
    { "type": "suggestion", "note": "External org-chart lookup would confirm the budget-ownership claim." },
    { "type": "possible-duplicate", "note": "This Steve may be the same as last week's 'S. Park'.", "refs": ["Steve"] }
  ]
}
```

- **`entityId`** (required): echoes the entity under analysis (must match the queue item;
  mismatch fails validation).
- **`claims[]`** (required, **may be empty**): the assertions the source makes about this
  entity. An entity the source merely name-drops yields **zero** claims — a valid outcome.
  - **`statement`** — a concise natural-language assertion **about the subject entity**,
    grounded in the source. It may *name* other entities in prose, but the claim's subject
    is always the queue-item entity (§3.3).
  - **`status`** — `fact` | `interpretation` | `hypothesis` (DATA-7; PRIN-3). A **closed**
    set, validated by the orchestrator — distinct from the *open* `kind`/signal `type`
    vocabularies. This is the field DECOMP-15 deferred to here.
  - **`confidence`** — calibrated belief (0–1) that the claim is real and correctly parsed
    (DATA-7). A later Review stage may route low-confidence claims (SCOPE-9); v1 does not
    gate on it.
  - **`mentions[]`** — verbatim span(s) from the source evidencing the claim (DATA-7
    evidence; the agent must not assert anything ungrounded in the source text).
  - **`relatesTo[]`** (optional) — names/mentions of other entities the statement touches:
    a **soft, unresolved hint for Connect**, explicitly **not** a typed link (§3.3,
    CLAIMS-10).
- **`signals[]`** (optional, usually absent): the agent's escape hatch — same channel and
  rules as Decompose (§3.4 / DECOMP-9).

### 3.2 The claim file (what the orchestrator writes)

One file per claim, deterministic template, **orchestrator-authored**. Physical layout
(`claims/` date-shard vs. flat vs. partitioned-by-subject) is architecture — pinned at
build time.

```markdown
---
id: 01JC…                            # orchestrator-minted ULID (not the agent's)
subject: entities/01JABCG9…          # the entity this claim is about
status: interpretation               # fact | interpretation | hypothesis (closed set)
confidence: 0.7
provenance:                          # DATA-5: derived-from + transforming agent
  derivedFrom: [sources/2026/05/30/01JABCDEF7Q2…]   # the WHOLE source (CLAIMS-5)
  transformedBy: "claims · copilot session 01JC…"
  mentions: ["Steve owns the Q3 budget line"]       # corroborating span(s)
relatesTo: ["Austin site"]           # OPTIONAL soft hint for Connect — NOT a typed link
createdAt: 2026-05-30T18:30:00Z
---

Owns the Q3 budget.
```

- The claim carries the **full epistemic triad** (`status` + `confidence` + `evidence`);
  the entity **node** does not gain `status` (consistent with DECOMP-15) — epistemics are
  recorded at the level the assertion is actually made.
- v1 writes a **fresh claim every time** — no cross-source/-claim dedup (deferred to
  Connect). Two sources both asserting "Steve owns the budget" produce two claim files,
  each with its own `derivedFrom`. Expected and acceptable for the skeleton.

### 3.3 Single-subject claims, and the Claim ↔ Link boundary (the "between the two")

A claim's **subject is always one entity** — the queue item. This is the boundary the
Principal drew: a claim may *express* a relationship in its statement and may carry a
soft `relatesTo` hint, **but it does not establish that relationship "in proper."** The
typed, reconciled edge ("Steve → manages → Austin site") is created only by **Connect**,
which has identity resolution across sources.

So Claims sits deliberately *between* "single-subject only" and "full relational claims":
- It **may** record `"Reports to the Austin site lead"` as a claim about *Steve* and tag
  `relatesTo: ["Austin site lead"]`.
- It **does not** mint a `Steve —manages→ Austin` edge, dedup "Austin site" against other
  mentions, or assert the relation as graph truth. Those are Connect's, fed by these
  hints. The hint is a *breadcrumb*, non-authoritative until Connect resolves it.

This keeps Claims zero-resolution (like Decompose) while still capturing the relational
*signal* the source contains, so nothing is lost waiting for Connect.

### 3.4 Signals & the audit envelope (reused from Decompose)

Identical mechanism to SPEC-0015 §3.3–3.4, reused unchanged:
- A **signal** `{ type: <open string>, note: <free text>, refs?: [<string>] }` is the only
  way the agent puts something **not a claim** on the record; its destination is the
  **audit log only** (DATA-10, AUTO-8) — never a claim file, entity node, or source.
- `type` is an **open vocabulary** (base set suggested in the instruction file:
  `note, possible-duplicate, suggestion, conflict, low-quality-source, needs-research`);
  the agent may coin others. Optional and usually absent.
- The orchestrator wraps each claim write and each signal in a **rigid, code-generated
  envelope** (`ts, runId, stage:"claims", entityId, sourceId, model, event`) and appends
  JSONL colocated with the item (ORCH-11). Structure lives in the envelope; freedom in the
  payload.

### 3.5 The entity node's generated claims block (the hybrid back-link)

Claim files are **canonical** (full epistemics live there). For Obsidian-native
readability, the orchestrator *also* maintains a **clearly delimited, regenerable** block
inside the entity node so its substance reads in place:

```markdown
# Steve

<!-- kb:claims:start (generated — edit claims/, not here) -->
- [[claims/01JC…]] — Owns the Q3 budget. *(interpretation, 0.7)*
- [[claims/01JD…]] — Attended the Austin site visit on May 14. *(fact, 0.95)*
<!-- kb:claims:end -->
```

- The block is **orchestrator-authored, never agent-authored**, and **regenerated whole**
  from the set of claims whose `subject` is this entity — so it is **idempotent** and safe
  to rebuild on every run / replay (CLAIMS-9).
- It is the *only* part of the entity node Claims may write. The **Decompose-authored
  identity** (frontmatter `id`/`kind`/`name`, provenance, the `# Name` heading) is **never
  touched** (CLAIMS-11). The two stages own disjoint regions of the file.

### 3.6 Edge flows (failure tolerance)

- **Malformed / invalid / wrong-`entityId` decision** — the entity stays in
  `queue/claims/`, the failure is audited and retried; after **K** attempts it is **flagged
  and set aside** (does not head-of-line-block the serial queue) — never dropped (ORCH-12).
  The agent has no write tools, so it cannot half-write anything.
- **Crash mid-claims** — the item is still in the queue (it leaves only after the commit);
  on restart the orchestrator re-reads and re-derives. Because claim ids are minted fresh
  and committed atomically per entity, and the node block is regenerated whole, a re-run
  before commit leaves no orphaned partial claims (ORCH-13).
- **Empty result** — an entity the source merely mentions commits **zero** claims
  (optionally a `note` signal), still regenerates an (empty) block, and dequeues cleanly.
  A valid outcome.
- **Entity already has claims (re-poke / replay)** — claim files are append-only fresh
  writes and the node block is regenerated whole, so re-processing is idempotent at the
  block level (it does **not** dedup prior claim *files* — that's Connect).
- **Window closed** — Claims runs headless on the orchestrator like every stage (ORCH-1).
- **User recovery of a set-aside item (#137 escape hatch)** — a set-aside entity is not a dead
  end. The Principal can **retry** it — a per-entity `reopened` marker supersedes the prior
  `setaside`/`failed` count so the entity re-enters the queue and re-derives, with **siblings of
  the same source untouched** (per-ENTITY, *not* a source-wide `replay-reset` epoch, which would
  re-derive every entity of that source) — or **dismiss** it: a **terminal `dismissed`** marker
  permanently retires it (never retried, never re-derived; distinct from the recoverable
  `setaside`). Both are **append-only** on the source audit (CLAIMS-11) and committed **under the
  canonical-writer lock** (CLAIMS-15). `listSetAsideItems` enumerates the recoverable set; the
  Status view surfaces it and offers the actions (SPEC-0030 OBS-17). (CLAIMS-20)

## 4. Requirements

| ID         | Priority | Statement (short)                                                  | Verify   | Traces |
| ---------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| CLAIMS-1   | must     | A Claims stage drains entities and derives the **claims** their source makes about each into `claims/`, giving entity pages substance | test:claimsStage.test.ts | LIFE-3; VISION-5 |
| CLAIMS-2   | must     | Claims is **one instance of the SPEC-0014 harness** (own work-list, own worktree, own instruction file/model); the engine is reused unchanged | test:claimsStage.test.ts | ORCH-9 |
| CLAIMS-3   | must     | The Claims agent is **thin / cognition-only**: it returns a structured decision and is granted **no** shell/write/git tools; the orchestrator performs all effects | test:claimsAgent.test.ts, claimsStage.test.ts | ORCH-7; AUTO-3 |
| CLAIMS-4   | must     | Each work item is handled in a **fresh, isolated agent session** (one entity, empty context) | test:claimsAgent.test.ts | ORCH-5; AUTO-2 |
| CLAIMS-5   | must     | The work unit is **one entity node + the WHOLE source it derives from** (full source text, not just the Decompose mention spans) | test:claimsStage.test.ts, claimsAgent.test.ts | DATA-5; LIFE-3 |
| CLAIMS-6   | must     | Each derived claim is written as a versioned file in `claims/` with **subject → entity**, **evidence** (`derivedFrom` → the whole source + `mentions`), and a transforming agent | test:claimDoc.test.ts, claimsStage.test.ts | DATA-3,5,7 |
| CLAIMS-7   | must     | **`status` (fact/interpretation/hypothesis) is a per-claim attribute** (alongside `confidence` + evidence); entity **nodes** remain status-free — resolving SPEC-0007 §8 and DECOMP-15 | test:claimDoc.test.ts, claims.test.ts | DATA-7; PRIN-3 |
| CLAIMS-8   | must     | Claim `status` is a **closed** validated set `{fact, interpretation, hypothesis}` (distinct from the *open* `kind`/signal-`type` vocabularies); an invalid status fails validation | test:claims.test.ts | DATA-7; PRIN-3 |
| CLAIMS-9   | must     | The orchestrator maintains a **delimited, regenerable, idempotent "claims" block** inside the entity node (the hybrid back-link); canonical claim data lives in `claims/`, not the node | test:claimDoc.test.ts, claimsStage.test.ts | DATA-3; VAULT (Obsidian-native) |
| CLAIMS-10  | should   | Claims are **single-subject**; a claim **may** name other entities in prose or carry a soft `relatesTo` hint, but **does not establish a typed cross-entity link** — that is Connect's, fed by these hints | test:claims.test.ts, claimsAgent.test.ts | DATA-8; LIFE-3,6 |
| CLAIMS-11  | must     | Claims **never mutates the immutable source, nor the Decompose-authored identity** of the entity node (id/kind/name/provenance/heading); it only writes `claims/` and the generated block | test:claimsStage.test.ts, claimDoc.test.ts | DATA-2; LIFE-2 |
| CLAIMS-12  | must     | The agent decision is **validated against a schema** (incl. `entityId` match + closed `status`); an invalid decision never loses the entity — it is flagged and retried, then set aside after K | test:claims.test.ts, claimsAgent.test.ts, claimsStage.test.ts | ORCH-12; INGEST-8 |
| CLAIMS-13  | must     | The agent may emit optional **signals** (typed freeform `{type, note, refs?}`, open vocab) routed to the **audit log only**, never into the KB | test:claimsStage.test.ts, claims.test.ts | DATA-10; AUTO-8 |
| CLAIMS-14  | must     | Every Claims run **emits append-only audit events** in the rigid orchestrator-owned **envelope** (ts, runId, stage, entityId, sourceId, model, event) wrapping freeform payloads | test:claimsStage.test.ts | ORCH-11; DATA-10 |
| CLAIMS-15  | must     | The graph delta is **committed per entity** and the canonical tree advances only by completed commits via the serialized writer | test:claimsStage.test.ts | ORCH-3; DATA-9 |
| CLAIMS-16  | must     | Claims is **idempotent / restartable**: an item leaves the **derived work-list** only once its result is committed (terminal marker); crash/re-poke resumes without duplicating committed claims, and the node block regenerates whole | test:claimsStage.test.ts | ORCH-4,13 |
| CLAIMS-17  | should   | **No cross-_source_ dedup**: the same assertion from two **different sources** yields two claims (independent provenance); cross-source merge/retraction stays a Connect/Reflect concern, fed by `possible-duplicate` signals. (Within-_source_ near-dupes are now collapsed — CLAIMS-19.) | test:claimsStage.test.ts, claimDedup.test.ts | DATA-3; LIFE-8 |
| CLAIMS-18  | should   | The Claims work-list is discovered by a **derived sweep of `entities/`** in v1 (terminal `claims` marker in the source audit, keyed by `entityId`); the eventual seam is a **`queue/claims/` folder + per-entity poke** (DECOMP-16) — later stages attach with no change to Claims | test:claimsStage.test.ts | ORCH-9,15; DECOMP-16 |
| CLAIMS-19  | should   | **Within-source near-duplicate claim collapse**: claims that share the **same source provenance** AND normalize to the **same statement** collapse to one canonical (fact>interpretation>hypothesis, then confidence, then earliest id); the rest are deleted and the affected nodes' claims blocks regenerated. Deterministic + idempotent; runs as **Connect's post-Claims pass** (SPEC-0016 §6). Symmetric-relationship rewordings ("A↔B") are NOT collapsed — deferred to typed links (SPEC-0020 CONNECT-20); the residual is logged | test:claimDedup.test.ts, connectStage.test.ts | DATA-3; LIFE-8; SPEC-0020 |
| CLAIMS-20  | should   | A **set-aside claims item is user-recoverable** (the #137 escape hatch): `retryClaimsItem` appends a **per-entity `reopened`** marker that supersedes the prior `setaside`/`failed` count so the entity re-enters the queue and re-derives (per-ENTITY, **not** a source-wide replay epoch — siblings untouched); `dismissClaimsItem` appends a **terminal `dismissed`** marker (permanently retired, never re-derived, distinct from the recoverable `setaside`); `listSetAsideItems` enumerates the recoverable set. All append-only on the source audit (CLAIMS-11), committed under the canonical-writer lock (CLAIMS-15) | test:claimsStage.test.ts | ORCH-12; SPEC-0030 OBS-17; [#137](https://github.com/masra91/KB-App/issues/137) |
| CLAIMS-21  | must     | A **Connect-merged entity has MANY sources** (`derivedFrom` is multi-valued post-Connect): Claims processes it **per (entity × source)** — **every** source contributes its claims (within-source restatements collapse via CLAIMS-19; cross-source restatements are kept with independent provenance via CLAIMS-17). Deriving from only `derivedFrom[0]` **silently drops the later sources' facts — data loss — and is prohibited.** Each resulting claim's `evidence.derivedFrom` references the **single** source it came from (clean per-claim provenance) | none-yet | CLAIMS-5,17,19; SPEC-0020 CONNECT; [data-loss dogfood] |

### CLAIMS-5 — The work unit is an entity + its whole source
- **Status:** draft · **Priority:** must
- **Statement:** A Claims work item is one **entity** (`entities/<E>`); the agent session
  **MUST** be given that node **and the complete text of the source it was derived from**
  (its single `derivedFrom`), not merely the mention spans Decompose recorded. The claim's
  `evidence.derivedFrom` **MUST** reference that whole source.
- **Rationale:** The substance an entity needs lives in the *body* of the source, beyond
  the spans that merely proved the node exists. Feeding the whole source lets Claims
  extract assertions Decompose never spanned, while the entity scopes *whom the claims are
  about*. This is well-defined in v1 precisely because Decompose mints one node per source
  (DECOMP-14) — one entity ↔ one source. (Revisited under §7 when Connect merges nodes.)
- **Traces:** DATA-5, LIFE-3
- **Verify:** none-yet

### CLAIMS-7 — `status` is a per-claim attribute (epistemic granularity, resolved)
- **Status:** draft · **Priority:** must
- **Statement:** `status` ∈ `{fact, interpretation, hypothesis}` **MUST** be recorded on
  the **claim**, alongside `confidence` and `evidence`. Entity **nodes** **MUST NOT** carry
  `status` (they keep `confidence` + evidence per DECOMP-15). This pins SPEC-0007 §8's open
  "entity vs. claim vs. both" question to: **epistemics at both levels, but `status` only
  where an assertion is actually made — the claim.**
- **Rationale:** A *node* ("Steve") has no truth-value to be fact/hypothesis — only an
  *assertion about* it does. Putting `status` on claims keeps epistemics where they mean
  something and keeps the node a stable identity anchor. Lightweight (attributes +
  provenance), per SPEC-0007 §4 — not a separate subsystem.
- **Traces:** DATA-7, PRIN-3
- **Verify:** none-yet

### CLAIMS-9 — Hybrid storage: canonical claim files + regenerable node block
- **Status:** draft · **Priority:** must
- **Statement:** Claim data **MUST** be canonical in `claims/` files (full epistemics +
  provenance). The orchestrator **MUST** additionally maintain a **clearly delimited,
  generated** claims block inside the entity node, **regenerated whole** from the entity's
  claims on every run (idempotent), so the entity reads as a complete page in Obsidian.
  The block **MUST** be marked as generated and **MUST NOT** be the source of truth.
- **Rationale:** The Principal's call: native single-file readability (KB-as-Obsidian-vault
  principle) *and* clean provenance/replay (no scattering epistemics into the node, no
  cross-stage fight over the node's identity region). Regenerate-whole makes it conflict-
  free and replay-safe; a human edit inside the markers is expected to be overwritten.
- **Traces:** DATA-3, VAULT (Obsidian-native substrate)
- **Verify:** none-yet

### CLAIMS-10 — Single-subject claims; relations hinted, not established
- **Status:** draft · **Priority:** should
- **Statement:** A claim's `subject` **MUST** be exactly one entity (the work item). A
  claim **MAY** reference other entities in its `statement` and **MAY** carry a soft
  `relatesTo` hint, but Claims **MUST NOT** create typed cross-entity links, resolve
  identity, or assert relations as graph truth. Establishing reconciled typed links is
  **Connect's** responsibility, fed by these hints.
- **Rationale:** The Principal's "between the two": capture the relational *signal* a single
  source contains without prematurely committing a graph edge that needs cross-source
  identity resolution to be trustworthy. Keeps Claims zero-resolution (like Decompose) and
  leaves Connect a clean, well-fed seam.
- **Traces:** DATA-8, LIFE-3, LIFE-6
- **Verify:** none-yet

### CLAIMS-11 — Derive only; never mutate source or node identity
- **Status:** draft · **Priority:** must
- **Statement:** Claims **MUST NOT** edit, move, or empty the source, and **MUST NOT**
  alter the Decompose-authored identity of the entity node (its `id`/`kind`/`name`,
  provenance frontmatter, or `# Name` heading). The *only* node mutation permitted is
  (re)writing the delimited generated claims block (CLAIMS-9).
- **Rationale:** Sources are immutable ground truth (DATA-2) and node identity is
  Decompose's contract; cross-stage writes must touch disjoint regions or the Replay/trust
  model and stage independence break. Disjoint ownership keeps the harness reuse honest.
- **Traces:** DATA-2, LIFE-2
- **Verify:** none-yet

### CLAIMS-19 — Within-source near-duplicate claim collapse
- **Status:** draft · **Priority:** should
- **Statement:** A **within-source** dedup pass **MUST** collapse claims that share the **same
  source provenance** (`derivedFrom`) and whose statements **normalize to the same text** down
  to a single canonical claim. The canonical is chosen deterministically: **status** rank
  (`fact` > `interpretation` > `hypothesis`), then higher **confidence**, then earliest **id**.
  The non-canonical duplicates are **deleted** and every affected entity node's generated claims
  block is **regenerated** from the survivors (CLAIMS-9); identity is never touched (CLAIMS-11).
  The pass **MUST** be **idempotent** (re-running collapses nothing further) and **MUST NOT**
  merge claims from **different** sources (CLAIMS-17) nor collapse **symmetric rewordings**
  ("A worked with B" vs "B worked with A"). Statement normalization is therefore
  **order-sensitive**. It runs as **Connect's post-Claims pass** (§6), under the canonical-writer
  lock, and **logs** what it collapsed plus a heuristic count of suspected symmetric residuals. Its
  destructive sinks (the claim-file delete + the entity-node block rewrite) are routed through the
  shared symlink-safe containment guard (`assertContainedRel`, fail-closed) before the fs op, parity
  with the Connect/Reflect merge sink (#80/#82).
- **Rationale:** Dogfooding surfaced a tiny input producing ~11 near-duplicate claims — the same
  assertion restated once per entity. Collapsing exact/trivially-reworded restatements within a
  single source's testimony is a safe, deterministic felt-quality win that does **not** disturb
  the deliberate cross-source posture (CLAIMS-17: different sources keep independent claims). The
  remaining *symmetric relationship* duplicates are not a wording problem but a **modeling** one
  — the same edge asserted on both endpoints — whose correct fix is a single typed edge
  (**CONNECT-20**); collapsing them textually would lose the relationship from one node's page,
  so they are deferred and merely counted, making the typed-links consumer-need visible.
- **Traces:** DATA-3, LIFE-8, SPEC-0020 (Connect / CONNECT-20)
- **Verify:** test:claimDedup.test.ts, connectStage.test.ts

## 5. Concurrency & failure model (v1 posture)

Inherits SPEC-0015 §5 / SPEC-0014 verbatim, with one Claims-specific note:

- **Serial within the stage** (ORCH-6); **pipelined across stages** — while Claims works
  entity A, Decompose can be decomposing source B and (later) Connect can work entity Z.
  Separate queues + separate worktrees = free, safe parallelism.
- **The canonical advance is serialized** — the one shared resource is the canonical git
  ref; every stage's "fast-forward canonical + refresh root" goes through a single
  serialized writer (resolves SPEC-0014 / DATA §8 for v1; full DAG concurrency deferred).
- **Cross-stage write to the same file** — Claims regenerates a *delimited block* in an
  entity node Decompose authored earlier. This is **not** concurrent contention: Claims is
  strictly downstream (it runs only after the node is committed), it touches a **disjoint
  region** (CLAIMS-11), and it lands through the same serialized canonical writer — so it
  is a clean sequential edit, not a merge conflict. Regenerate-whole keeps it idempotent.
- **Failure is contained per stage** — each stage dequeues only on commit, so a Claims
  crash never loses or redoes Decompose's work; a poison entity is flagged and set aside
  after K attempts rather than blocking the serial queue (ORCH-12).
- **Replay falls out for free** — source immutability + "read input → derive → commit"
  means Claims can be re-run over old entities later (better model, new claims) by
  re-enqueuing; the node block regenerates and stale generations live in git history
  (LIFE-10, DATA-11).

## 6. The Enrich chain (where this hands off)

Claims is stage 2 of the chain; each later capability is **its own SPEC-0014 instance**
(own queue, worktree, instruction file, model — independently upgradable and replayable).
Every seam is a **queue folder + poke** (CLAIMS-18); nothing built here changes when these
attach:

```
sources/ ─→ queue/decompose/ ─[DECOMPOSE]→ entities/ (nodes)                     ← SPEC-0015
                                  │ poke (per entity)
                                  ▼
            queue/claims/    ─[CLAIMS]→ claims/ + entity node substance           ← this spec
                                  │ poke
                                  ▼
            queue/research/  ─[RESEARCH]→ secondary sources + corroborated claims (egress; thick agent) ← deferred
                                  │ poke
                                  ▼
            queue/connect/   ─[CONNECT]→ entity resolution / merge / typed links ("which Steve?", relatesTo→edges) ← deferred
```

- **Research** corroborates/expands claims externally (AUTO-4 egress; likely thick agent);
  it consumes Claims' `needs-research`/`suggestion` signals.
- **Connect** resolves identity across sources and **promotes** claim `relatesTo` hints into
  reconciled typed links, deduping nodes and claims; fed by `possible-duplicate` signals and
  escalating genuine ambiguity to **Review** (LIFE-6). It also runs a **within-source
  claim-dedup pass** (CLAIMS-19) once Claims settle — collapsing near-duplicate statements that
  share one source's provenance (the "same assertion restated per-entity" clutter). The
  symmetric *relationship*-restated-on-both-endpoints case is left for **typed links
  (CONNECT-20)**, where an edge is asserted once rather than mirrored per node.
- **Reflect** (cross-cutting, LIFE-8) curates emergent vocabularies and surfaces stale or
  conflicting claims across the corpus.

## 7. Open questions

- [x] **`claims/` physical layout** *(architecture)* — *resolved at build time:*
      **`claims/<dateShard(id)>/<id>.md`**, mirroring `entities/`. (Partition-by-subject was
      considered but date-shard keeps the convention uniform across sources/entities/claims.)
- [x] **Entity-driven unit after Connect** — *resolved (Principal ruling, 2026-06-02):*
      **per (entity × source)** — once Connect merges nodes spanning multiple sources, Claims
      runs over **each** `derivedFrom` source of the merged entity, not just the first. Chosen
      over re-running across the combined merged entity because per-source processing keeps
      **clean per-claim `Source: [[…]]` provenance** (the citation/grounding model) and aligns
      with CLAIMS-17 (cross-source restatements kept) + CLAIMS-19 (within-source collapse).
      Pinned as **CLAIMS-21**. Surfaced by DEV-1's enrich dogfood as a live **data-loss** bug
      (a merged entity's later sources' facts were silently dropped — only `derivedFrom[0]`
      processed); the deferral condition ("revisit when Connect is specced") resolved when
      Connect shipped (SPEC-0020).
- [ ] **`relatesTo` shape** — bare entity-name strings (as drafted) vs. a richer
      `{name, predicate?}` hint. Kept minimal for v1; Connect's needs will pin it.
- [ ] **Claim granularity / dedup within one run** — should the agent be nudged to emit
      atomic one-fact claims, or are compound claims acceptable? Affects later dedup. (Tune
      via the instruction file once real outputs are observed.)
- [ ] **Confidence vs. status interaction** — is a low-confidence `fact` meaningfully
      different from a high-confidence `hypothesis`? Whether Review routes on `status`,
      `confidence`, or both is deferred to the Review spec.
- [ ] **Retry budget K** — shared with Decompose (SPEC-0015 §7); a small constant, tuned on
      observed failure modes.
- [ ] **Generated-block human edits** — a human editing inside `kb:claims:start/end` will be
      overwritten on regenerate. Acceptable for v1; a future "pin a note" affordance could
      promote such edits to a real claim. (Architecture.)

## 8. Changelog

- 2026-06-02 — **CLAIMS-21: per-(entity × source) claims for Connect-merged entities** (resolves
  §7's deferred "entity-driven unit after Connect"; Principal ruling). A merged entity has many
  `derivedFrom` sources; Claims now derives from **each** of them, not just `derivedFrom[0]` —
  closing a **data-loss** bug DEV-1's enrich dogfood reproduced (a merged entity's later sources'
  facts were silently dropped). Per-source chosen over a combined re-run to preserve clean
  per-claim provenance (CLAIMS-17/19 handle dedup). A **fails-before/passes-after** regression
  test (the Grace-Hopper-across-2-sources repro) is required before the fix lands (E2 bar).
- 2026-06-02 — **CLAIMS-20: set-aside items are user-recoverable** (#137 escape hatch backing
  SPEC-0030 OBS-17). Added `retryClaimsItem` (per-entity `reopened` marker → re-enters the queue,
  siblings untouched — deliberately *not* a source-wide `replay-reset` epoch, which would
  re-derive every entity of the source), `dismissClaimsItem` (terminal `dismissed` marker →
  permanently retired), and `listSetAsideItems` (the recoverable list); exported `readClaimsState`
  with a `terminalReason` (`claimed`/`setaside`/`dismissed`). All append-only on the source audit
  (CLAIMS-11), committed under the canonical-writer lock via the same optimistic-advance machinery
  as a normal claims commit. The Status-view surface that calls these is DEV-3's OBS-17 half.
- 2026-05-30 — created (draft). Second Enrich stage and third user of the SPEC-0014
  harness. Entity-driven: one entity node + its **whole** derived-from source → thin
  cognition-only agent → validated claims decision → orchestrator-written `claims/` files
  (subject → entity, evidence → source) **plus** a regenerable delimited "claims" block in
  the entity node (hybrid storage). Pins per-claim `status`
  (`fact|interpretation|hypothesis`, a **closed** set) — resolving SPEC-0007 §8 and
  DECOMP-15 (entity nodes stay status-free). Claims are **single-subject**; relations are
  *hinted* (`relatesTo`) but **established only by Connect** ("between the two"). Reuses the
  Decompose signal channel + audit envelope. Deferred (each a later SPEC-0014 stage off the
  queue seam): external Research (egress/thick agent), Connect (identity resolution, typed
  links, dedup), claim retraction/supersession. Concurrency posture inherited
  (serial-in-stage, pipelined-across-stages, serialized canonical writer); cross-stage node
  writes are disjoint-region + downstream + regenerate-whole, hence conflict-free.
- 2026-06-02 — **CLAIMS-19 WIRED into Connect (discharged).** The dedup pass now runs as Connect's
  post-Claims pass: `ConnectStage.drainOnce` calls `dedupClaimsOnce` (after link-promotion, under the
  shared canonical-writer lock) — reset-to-base → `applyClaimDedup` on the worktree → commit + ff-merge,
  mirroring `linkOne`; a drop sets `worked` so the deletions promote `staging`→`main` via the
  deletion-aware gate. The destructive sinks are hardened with the shared `assertContainedRel`
  containment guard (claim delete under `claims/`, node rewrite under `entities/`; #80/#82 parity).
  Added an **integration test** (`connectStage.test.ts`) proving a real drain collapses within-source
  dupes + advances canonical (and leaves symmetric rewordings for CONNECT-20) — so CLAIMS-19 is now
  behaviorally verified, not just unit-tested. (Closes #34 part-2 wiring; the eval/golden-set is the
  remaining cross-cutting behavioral check for DECOMP-17 + CLAIMS-19.)
- 2026-06-02 — **CLAIMS-19 (within-source dedup).** Dogfooding surfaced ~11 near-duplicate
  claims for a tiny input (the same assertion restated per-entity). Graduated the deferred dedup
  boundary: **within-source** near-duplicate statement collapse is now in scope (CLAIMS-19),
  built as a **separable module** (`app/src/kb/claimDedup.ts`: pure `dedupeClaimsWithinSource`
  + the file-effecting `applyClaimDedup` pass + heuristic residual counter) with requirement-
  traced tests (`claimDedup.test.ts`). Grouped strictly by source provenance so **CLAIMS-17**
  (no cross-_source_ dedup) is preserved verbatim; normalization is **order-sensitive** so the
  symmetric "A↔B" relationship case is *not* collapsed — that is deferred to **typed links
  (SPEC-0020 CONNECT-20)** and only logged as a residual. Refined CLAIMS-17 + §2 + §6 to reflect
  the within-vs-cross-source split. **Wiring** of the pass into Connect's post-Claims point is
  sequenced separately (connectStage/pipeline concurrently in flight); the module + its
  guarantees stand alone. (Part 2 of the enrich-quality work; Part 1 = SPEC-0015 DECOMP-17.)
- 2026-05-30 — **implemented** (`app/src/kb/claims.ts`, `claimDoc.ts`, `claimsAgent.ts`,
  `claimsStage.ts`; wired in `main/pipeline.ts` sharing the canonical-writer lock). Third
  user of the SPEC-0014 harness, mirroring Decompose. v1 work-list is **derived** (sweep
  `entities/`; terminal `claims` marker in the source `audit.jsonl` keyed by `entityId`) —
  there is no `queue/` folder yet, matching the merged Decompose reality (§3 note). Claim
  layout pinned to `claims/<dateShard(id)>/<id>.md`. Closed `status` enforced in code; open
  signal `type` reuses the Decompose validator. On failure the worktree is reset (no partial
  claim files) then a `failed`/`setaside` marker is committed (CLAIMS-12). All `must`
  requirements graduated `Verify: none-yet → test:` with requirement-traced tests; injected
  deciders keep CI credential-free (no copilot shell-out).
