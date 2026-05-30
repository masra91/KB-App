---
spec: SPEC-0008
key: INGEST
title: Ingestion Pipeline
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0004, SPEC-0005, SPEC-0006, SPEC-0007]
supersedes: null
stage: Ingest
---

# Ingestion Pipeline

> The common spine every piece of data travels once it arrives — regardless of which
> surface delivered it. **Preservation first**: archive the original immutably, then
> classify, catalog, and hand off to Enrich. This is the shared core under Quick
> Capture, Rich Ingestion, Folder-Watch, and Proactive Intake.

## 1. Intent (the why / JTBD)

Lifecycle Stage 1 (Ingest) says *"the primary responsibility of ingestion is
preservation."* Every arrival surface differs in *how data shows up*, but what happens
*after* arrival is identical and must be rock-solid: the original is preserved as
immutable ground truth **before** anything touches it, so Replay and provenance always
have something true to stand on. This spec owns that shared path.

## 2. Scope

**In scope:** from "an item has arrived" to "it is a preserved primary source,
classified, cataloged, and enqueued for Enrich."

**Out of scope:**
- The arrival **surfaces** themselves (Quick Capture / Rich Ingestion / Folder-Watch /
  Proactive Intake — their own specs); they call into this pipeline.
- **Enrichment** (entity extraction, research) — Stage 2, separate specs. The pipeline
  only *hands off* to it.

## 3. The pipeline (flow)

An arrival surface produces an **ingestion request** and calls the pipeline:

```
ARRIVE ──► ARCHIVE ──► CLASSIFY ──► CATALOG ──► ENQUEUE(Enrich)
(request)  (immutable   (scope +    (basic       (autonomous
           primary src, sensitivity) metadata,    handoff)
           commit)                   discoverable)
```

1. **Arrive** — accept an ingestion request: raw payload (text / URL / file / …) +
   arrival metadata (surface, timestamp, connector identity, any declared scope/
   sensitivity). The pipeline is **input-kind agnostic** (VISION-1).

2. **Archive (preserve)** — write the raw item as an **immutable primary source** into
   the vault and **commit to git**, establishing provenance/lineage, **before any
   processing** (LIFE-2, DATA-2/5/9). This step is sacred and must succeed first.

3. **Classify** — apply **scope + sensitivity**. Conservative defaults (`global`,
   `internal`) unless an **explicit or high-confidence signal** says otherwise —
   including **connector defaults** (SCOPE-14) and Principal-declared values. Uncertain
   classifications route to **Review** (SCOPE-9); they do not block preservation.

4. **Catalog** — extract **basic metadata** and register the source so it is
   **discoverable** (queryable / visible). Deep decomposition into entities is **Enrich's**
   job, not the pipeline's.

5. **Enqueue (Enrich)** — hand the preserved, cataloged source to the autonomous
   enrichment stage (runs on Orchestration; AUTO-2). Ingestion's responsibility ends here.

## 4. Requirements

| ID        | Priority | Statement (short)                                                  | Verify   | Traces |
| --------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| INGEST-1  | must     | One ingestion pipeline handles all arrivals regardless of surface  | none-yet | LIFE-1 |
| INGEST-2  | must     | Items are archived as immutable primary sources BEFORE any processing | none-yet | LIFE-2; DATA-2; PRIN-1 |
| INGEST-3  | must     | Archival establishes provenance (surface, time, connector) and commits to git | none-yet | DATA-5,9; PRIN-5 |
| INGEST-4  | must     | Items are classified with scope + sensitivity; conservative defaults; explicit/connector signals applied; uncertain → Review | none-yet | SCOPE-8,9,14 |
| INGEST-5  | must     | Basic metadata is extracted and the source is cataloged as discoverable | none-yet | LIFE-1 |
| INGEST-6  | must     | After preserve + catalog, the source is enqueued for Enrich (autonomous) | none-yet | LIFE-3; AUTO-2 |
| INGEST-7  | must     | The pipeline accepts arbitrary input kinds (text, URL, file, …)    | none-yet | VISION-1 |
| INGEST-8  | must     | A processing failure never loses the raw item; preservation is durable independent of later steps | none-yet | PRIN-1 |
| INGEST-9  | should   | Classification and catalog failures degrade gracefully (item stays preserved + flagged), not lost | none-yet | PRIN-1; LIFE-6 |

### INGEST-2 — Preserve before process
- **Status:** draft · **Priority:** must
- **Statement:** An ingested item **MUST** be written as an immutable primary source and
  committed **before** any classification, cataloging, or enrichment runs.
- **Rationale:** Ground Truth Is Sacred and Replay both require the original to exist
  untouched, independent of whatever derivation later succeeds or fails.
- **Traces:** PRIN-1, LIFE-2, DATA-2, VISION-4
- **Verify:** none-yet

### INGEST-8 — Never lose the raw item
- **Status:** draft · **Priority:** must
- **Statement:** If any step after Archive fails, the raw primary source **MUST** remain
  durably preserved; the failure is recorded and the item flagged for Review/retry.
- **Rationale:** A flaky classifier or enrichment must never cost the Principal their data.
- **Traces:** PRIN-1, LIFE-6
- **Verify:** none-yet

## 5. Open questions

- [ ] **Dedup / re-ingestion** — if the same item arrives twice (e.g. folder re-scan),
      is it deduped, versioned, or stored twice? (Likely content-hash dedup; confirm.)
- [ ] **Large/binary files** — are images/PDFs/audio stored in-vault, or referenced with
      a pointer + extracted text? (Affects git repo size; partly architecture.)
- [ ] **Synchronous vs. async classify** — does classify happen inline at ingest, or is
      it also deferred to the Enrich queue? (Leaning: minimal inline default + connector
      signal; richer classify in Enrich.)
- [ ] **Catalog representation** — what does "cataloged/discoverable" mean concretely
      before Enrich runs? A source record + frontmatter? (Architecture-adjacent.)
- [ ] **Ingestion request schema** — the normalized shape every surface produces. Pin
      when the first surface (Quick Capture) is specced.

## 6. Changelog

- 2026-05-30 — created (draft). First feature spec. The shared Ingest spine:
  arrive → archive (immutable, committed) → classify → catalog → enqueue Enrich.
