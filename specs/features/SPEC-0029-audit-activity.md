---
spec: SPEC-0029
key: AUDIT
title: Audit & Activity (lineage + read-only views)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0004, SPEC-0006, SPEC-0007, SPEC-0014, SPEC-0017, SPEC-0019, SPEC-0021, SPEC-0022]
stage: Audit
supersedes: null
---

# Audit & Activity (lineage + read-only views)

> Make the KB's history **visible and explainable**. Two halves: (1) a **canonical audit model
> + cross-cutting coverage mandate** so *every* feature records what it did and **why**
> (formalizing the envelope the stages already use); and (2) **read-only views** — a curated
> **Activity feed**, a **Lineage** tracer, and **filter/search** — over a **derived, rebuildable
> activity index**. Discovery and viewing only; no interactive/mutating features. SPEC-0004
> Stage 7 (Audit), LIFE-9, AUTO-8/9.

## 1. Intent (the why / JTBD)

The KB acts autonomously — stages enrich, jobs ruminate, researchers fetch, recall answers.
For the Principal to **trust** it, the history must be **inspectable and explainable**: *"what
did the machine do, when, and why; how did this entity come to be; what's happening right
now."* (LIFE-9.) The data already exists — append-only `audit.jsonl` per item (DATA-10), with a
uniform envelope (ORCH-11) and the *why* (AUTO-8). What's missing is **one spec that owns the
model + coverage**, a **cross-item index** to see activity as a whole, and **views** to read it.

## 2. The audit model (formalizing what exists)

- **Canonical event envelope** (orchestrator-owned): `{ ts, runId, actor (stage/job/researcher/
  user), subject ids (sourceId / entityId / claimId / …), model (when an agent ran), event-type,
  payload }`. Freeform payloads ride **inside** the rigid envelope (the shape DECOMP-11 /
  CLAIMS-14 / Connect already use).
- **Append-only**, in the per-item **`audit.jsonl`** — the **lineage backbone** (DATA-10). Never
  edited or deleted; Replay **appends** epoch markers, never rewrites (REPLAY-6).
- **Coverage is the mandate** — every feature that mutates the KB or acts for the Principal emits
  a conforming event **with the why**, not just the what (AUTO-8). This spec is the **registry**
  of what's audited; **no silent actions**.

## 3. The derived activity index

Per-item `audit.jsonl` stays the **single source of truth**. Cross-KB views are powered by a
**derived, rebuildable index** aggregated from those files, cached under **`.kb/cache/`** (working
zone — gitignored, **never promoted** to `main`, **replay-safe** because it rebuilds from the
audit). This realizes the **audit global index** SPEC-0014 deferred — without a second source of
truth or double-write.

## 4. The read-only views

- **Activity feed** — a **curated, human-friendly** stream of recent activity across the KB
  (grouped/summarized per AUTO-9: "Connect merged 3 candidates into *Project Atlas*", "Web
  researcher added 2 sources on *X*"), with **drill-down to the raw audit events** behind any
  entry. Shows **recent + ongoing** (pipeline status, ORCH-10).
- **Lineage** — for any entity/source/claim/output: trace **where it came from** (provenance /
  `derived-from`), **what transformed it** (which stages/agents/researchers, when), and the
  decisions along the way.
- **Filter / search** — by entity, feature/stage, time range, agent/researcher, event-type.

**Read-only** — an observatory, not a control surface. No retries, edits, approvals, or
config here (those live in Reviews / Control Panel).

## 5. Requirements

| ID       | Priority | Statement (short)                                                                  | Verify   | Traces |
| -------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| AUDIT-1  | must     | Every audited action records a **canonical envelope** event (`ts, runId, actor, subject ids, model, event-type, payload`), **append-only** in the per-item `audit.jsonl` | none-yet | DATA-10; ORCH-11; AUTO-8 |
| AUDIT-2  | must     | **Cross-cutting coverage**: every feature/stage/job/researcher/review/recall/replay/panel-action that mutates the KB or acts for the Principal **emits a conforming event with the *why*** — no silent actions; this spec is the **coverage registry** | none-yet | AUTO-8; LIFE-9 |
| AUDIT-3  | must     | Audit is **append-only + immutable** — never edited/deleted; Replay **appends** epoch markers, never rewrites (REPLAY-6) | none-yet | DATA-10; CANON-11; PRIN-5 |
| AUDIT-4  | must     | A **derived, rebuildable activity index** powers cross-KB views — aggregated from per-item `audit.jsonl` (the single source of truth), cached in `.kb/cache/` (working zone, never promoted, replay-safe) | none-yet | DATA-10; STAGING-6; ORCH-15 |
| AUDIT-5  | must     | The **Activity feed** view shows a **curated, human-friendly** stream of recent + ongoing activity (AUTO-9) with **drill-down to raw events** | none-yet | AUTO-9; LIFE-9; ORCH-10 |
| AUDIT-6  | must     | The **Lineage** view traces, for any entity/source/claim/output, its **provenance + transformations + decisions** over time | none-yet | LIFE-9; DATA-5,10; PRIN-6 |
| AUDIT-7  | should   | **Filter/search** across the views by entity, feature/stage, time range, agent/researcher, event-type | none-yet | LIFE-9 |
| AUDIT-8  | must     | Audit views are **read-only** — discovery + viewing only; **no interactive/mutating actions** | none-yet | LIFE-9; AUTO-5 |
| AUDIT-9  | must     | Audit views live in the **shell** (SPEC-0017) as an **Activity** view (a top-level sibling, near Reviews), reading the derived index + per-item audit | none-yet | SHELL-1,2 |
| AUDIT-10 | should   | The audit/lineage reads cover both **working-zone** audit (full processing history on `staging`) and the **evergreen** source archival audit promoted to `main` | none-yet | STAGING-6,7; CANON-9 |
| AUDIT-11 | should   | A feature is **not "done" until it emits conforming audit** — audit coverage is a checked obligation, traceable to this spec (ties E2) | none-yet | AUTO-8; TEST-2 |

## 6. User flows / surface

- Open **Activity** → scan a human-readable feed of what the KB has been doing (and is doing
  now) → click an entry → see the raw audit events.
- Open an entity → **Lineage** → see the sources it derived from, the stages/researchers that
  shaped it, and when.
- **Filter** the feed to "Researchers, last 24h" or "everything touching *Project Atlas*."

## 7. Out of scope (for now)

- **Any interactive/mutating action** from audit views (retry, edit, approve) — those live in
  Reviews / Control Panel. Audit is read-only.
- **Long-term analytics / metrics dashboards** (counts, trends) beyond the activity feed.
- **External audit export / SIEM** integration.
- **Re-architecting emission** — the envelope already exists; this spec formalizes + indexes +
  views it, it does not rewrite per-feature audit.

## 8. Open questions

- [ ] **Curation engine** — is the human-friendly summarization deterministic (templated per
      event-type) or agent-generated? (Lean deterministic templates v1; cheap, predictable.)
- [ ] **Index freshness** — rebuild cadence / incremental update of the derived index (poke on
      audit append vs periodic sweep, mirroring ORCH-15).
- [ ] **Retention / volume** — audit grows unbounded; do we cap the *index* window (e.g. recent
      N) while the per-item `audit.jsonl` keeps full history?
- [ ] **Activity view placement** — top-level (like Reviews) vs under Manage. (Lean top-level:
      it's observation, not configuration.)
- [ ] **Coverage gaps** — confirm every current feature's audit obligation is `must` (the survey
      shows strong coverage; verify none are `should`-only where they mutate).

## 9. Changelog

- 2026-06-02 — created (draft). **Audit & Activity** (SPEC-0004 Stage 7): formalizes the
  **canonical audit envelope** + a **cross-cutting coverage mandate** (the registry of what's
  audited — audit everywhere, with the *why*, AUTO-8), a **derived rebuildable activity index**
  (from per-item `audit.jsonl`, cached, never promoted — realizes SPEC-0014's deferred global
  index), and **read-only views**: a curated **Activity feed** (AUTO-9 + raw drill-down), a
  **Lineage** tracer, and **filter/search**. Discovery + viewing only — no interactive features.
  Forks resolved with the Principal: **derived index**, **feed + lineage + search in v1**,
  **curated digest + raw drill-down**.
