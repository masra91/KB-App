---
spec: SPEC-0024
key: REFLECT
title: Reflect & Rumination (self-maintenance v1)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-01
updated: 2026-06-01
related: [SPEC-0004, SPEC-0006, SPEC-0014, SPEC-0016, SPEC-0018, SPEC-0020, SPEC-0021, SPEC-0023]
stage: Reflect
supersedes: null
---

# Reflect & Rumination (self-maintenance v1)

> The KB's **rumination** pass: a scheduled, bounded agent that wakes semi-regularly, looks
> at a slice of the KB, and catches what the event-driven pipeline missed or what has gone
> stale — **missed entities/claims, lost connections, emergent topics, stale nodes to retire,
> low-traction topics to consolidate.** It needn't change anything; as the KB grows it is
> where missed/emergent structure gets found and cruft gets pruned. The first job on the
> Autonomous Jobs engine (SPEC-0023). **Additive, high-confidence findings apply
> autonomously; anything destructive or low-confidence routes to Review.** SPEC-0004 Stage 6,
> LIFE-8.

## 1. Intent (the why / JTBD)

The Enrich pipeline (Decompose → Connect → Claims) is **per-source and forward-only**: it
does its best on each capture as it arrives. But a second brain's value compounds *across*
items over time — and the forward pass inevitably leaves gaps: an entity two sources both
implied but neither named cleanly; a connection that only becomes obvious once a third
source lands; a topic that quietly emerged across a dozen notes; a node that was hot last
quarter and is now dead weight. Several specs already **defer to Reflect** for exactly this
(SPEC-0020 recooks/re-clustering CONNECT-19; SPEC-0016 cross-source claim dedup CLAIMS-17;
SPEC-0015 vocabulary curation).

The job the Principal hires this for: *"keep noticing what I (and the first pass) missed, and
quietly tidy what's gone stale — without me curating, and without surprising me with risky
deletions."* Think of it as a **database cleanup job**: small, frequent, low-drama, fully
audited — **not** a major event. It runs **multiple times a day on a schedule** (later,
event-driven); most runs find little; occasionally one catches something real.

## 2. Scope

**In scope (v1):**
- A **Reflect job** on the SPEC-0023 engine: scheduled, bounded, single-flight, **concurrent**
  (optimistic, ORCH-17/18), richly audited, journal-backed.
- **Detection** of: missed entities/claims · missing/lost connections · emergent
  topics/themes · stale derived **metadata** (tags/labels/classifications) · low-traction topics.
- **Additive, high-confidence** repairs applied **autonomously** (audited): add a missed
  claim, restore a dropped link, group an emergent topic.
- **Metadata hygiene** — refresh/repair stale tags, labels, classifications (additive-ish, low-stakes).
- **Rare consolidation** — Reflect may **propose** entity merge/consolidation as **Review**
  items, executed through **Connect's merge machinery** on approval.
- **Disposition by posture** — default **Guarded** routes destructive/low-confidence to Review
  (SPEC-0018); the Principal may opt into **Autonomous** (agent judgment governs all).

**Out of scope (for now):**
- **Full-KB scans / global recooks** — a run never loads the whole KB (context blow-up);
  coverage is achieved over many bounded runs (§3.1). Whole-graph re-clustering is later.
- **Routine auto-deletion** — entity retire/merge/delete is never *routine*: rare,
  Review-gated curation under Guarded; only the opt-in **Autonomous** posture lets the agent
  judge destructive dispositions itself (the KB biases to **growth**, REFLECT-13).
- **New secondary sources** (re-fetching/researching) — that's Enrich/Research, not Reflect.
- **Event-driven triggering** — inherited from SPEC-0023 (schedule + manual only in v1).

## 3. How a rumination pass works

### 3.1 Working-set selection (never the whole KB)

Each run, the agent **adaptively picks** a **bounded working set** — leaning into churn when
activity is high, drifting to aged areas when quiet — recorded in the job journal (JOBS-7) so
coverage rotates over time:

- **Recency / churn** — recently added or changed entities/sources, where new structure and
  missed connections are most likely to have emerged.
- **Aged sampling** — a topic/area/cluster **not visited in a while** (round-robin or
  randomized via the journal cursor), so every corner of the KB is eventually revisited
  **without ever scanning all of it at once**.

The journal records what was visited and when; the next run reads it to choose the next slice
and to avoid re-chewing the same ground.

### 3.2 What it looks for

Over its working set, the agent looks for: entities/claims the forward pass **missed**;
**connections** that should exist but don't (or were lost on a merge); **emergent topics**
(recurring themes with no node yet); **stale/inactive** nodes (no new claims/links/activity
over a long window); **low-traction** topics (started but never developed, candidates to
consolidate into a neighbor).

### 3.3 Disposition (the autonomy split)

| Finding | v1 disposition |
| --- | --- |
| Add a missed claim / restore a link / group an emergent topic (**additive, high-confidence**) | **Auto-apply** on `staging`, audited (AUTO-2/3) |
| Refresh / repair a stale **tag / label / classification** (metadata, additive-ish) | **Auto-apply**, audited |
| Retire / merge / consolidate / delete a node (**destructive**) | **Review** (approve-first) |
| Anything **low-confidence / high-risk** | **Review** (approve-first) |

The table above is the **default "Guarded" posture** (REFLECT-12); the Principal may opt a
Reflect job into **"Autonomous"**, where the agent decides every disposition (including
destructive) by its own judgment. The KB **biases to growth** (REFLECT-13): staleness is
mostly **metadata hygiene**, and entity deletion/merge is rare, thoughtful curation — not
routine expiry. Approved merges reuse **Connect's merge machinery** (cluster → repoint claims
→ delete loser), deletions reaching `main` via deletion-aware promotion (STAGING-10). A run
that finds nothing actionable records an audit event and exits.

## 4. Requirements

| ID         | Priority | Statement (short)                                                                  | Verify   | Traces |
| ---------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| REFLECT-1  | must     | Reflect is an **autonomous job** on the SPEC-0023 engine — scheduled, bounded, single-flight, **concurrent** (optimistic, ORCH-17/18), richly audited — **not** an interactive stage | test:reflectJob.test.ts | JOBS-1,3,5; LIFE-8 |
| REFLECT-2  | must     | Each run operates on a **bounded working set, never the whole KB** — the agent **adaptively** chooses, per run via the job journal, between **recency/churn** and **aged sampling** of an under-visited area (lean into churn when busy, drift to aged areas when quiet); coverage accrues over many runs | test:reflectJob.test.ts | JOBS-4,7; PRIN-5; VISION-8 |
| REFLECT-3  | must     | Reflect detects at minimum: **missed entities/claims**, **missing/lost connections**, **emergent topics** (by the **agent's judgment** over the working set — no embeddings/preprocessing), **stale derived metadata** (tags/labels/classifications), and **low-traction topics** | test:reflectAgent.test.ts, reflectJob.test.ts | LIFE-8; PRIN-7,22 |
| REFLECT-4  | must     | **Additive, high-confidence** findings (missed claim, restored link, emergent grouping) are **applied autonomously and audited** | test:reflectJob.test.ts | AUTO-2,3; LIFE-3 |
| REFLECT-5  | must     | Under the **default "Guarded" posture**, **destructive** findings (retire/merge/consolidate/delete) and **all low-confidence/high-risk** findings **route to the Review queue** — never auto-applied; approved consolidation/merge **reuses Connect's merge machinery** | test:reflectJob.test.ts, jobStage.test.ts, mergeNodes.test.ts | AUTO-1,3,10; SPEC-0018; CONNECT |
| REFLECT-6  | must     | A run **may make no changes** — finding nothing actionable is a valid, expected outcome (maintenance, not production) | test:reflectAgent.test.ts, reflectJob.test.ts | PRIN-7 |
| REFLECT-7  | must     | Reflect writes on `staging`; changes publish via the gate, and retire/consolidate **deletions propagate to `main`** (deletion-aware promotion) | test:executeApprovedConsolidation.test.ts, mergeNodes.test.ts | STAGING-10; CANON-1,3 |
| REFLECT-8  | must     | Every run records its findings + reasoning in the **audit log** (the *why*) and updates the **job journal** (visited areas, cursor, deferrals) for the next run | test:reflectJob.test.ts, jobStage.test.ts | JOBS-7,8; AUTO-8 |
| REFLECT-9  | must     | Review items Reflect raises are **bounded decisions** (yes/no or small choice sets) with **provenance** to the entities/sources involved, consistent with SPEC-0018 | test:jobStage.test.ts | REVIEW-?; AUTO-10 |
| REFLECT-10 | should   | A manual **"Ruminate now"** trigger runs one bounded pass on demand (test/inspection affordance) | test:jobScheduler.test.ts | JOBS-11 |
| REFLECT-11 | should   | Reflect is the **convergence point** for deferred cross-KB concerns — Connect recooks/re-clustering (CONNECT-19), cross-source claim dedup (CLAIMS-17), vocabulary/kind curation — pulled in over later versions | none-yet | CONNECT-19; CLAIMS-17; DECOMP |
| REFLECT-12 | must     | Reflect's autonomy is a **configurable posture** with a **safe default** (JOBS-15 / AUTO-12): **Guarded** (REFLECT-5) by default; the Principal may **opt in** to **Autonomous**, where the agent's judgment governs all dispositions, incl. destructive | test:jobs.test.ts, reflectJob.test.ts | JOBS-15; AUTO-12 |
| REFLECT-13 | must     | **The KB biases toward growth, not shrink**: staleness work targets **derived metadata** (tags/labels/classifications), not entity deletion; **retiring/merging/deleting entities is a rare, Review-gated act of curation**, never routine expiry | test:reflectJob.test.ts | PRIN-1; DATA-1,2 |
| REFLECT-14 | must     | **Stateful — Reflect ACTS and never re-surfaces the same pile.** Today a run re-raises the **same reviews every time and doesn't act on them** (Principal). Before raising, a run MUST consult **(a) the open Review queue** (by the finding's `markerKey`/subject) and **(b) the durable disambiguation decisions** (REVIEW-18) — and **MUST NOT re-raise** a finding that is **already an open review** or an **already-answered/decided** pair. Each run **acts**: additive high-confidence findings auto-apply (REFLECT-4); ambiguous ones raise **once**, then the open review *is* the state (re-running does not duplicate it). So successive runs **surface NEW findings or progress prior ones — never re-present the same unanswered pile**. The journal (REFLECT-8) records what was raised/applied/deferred so the next run skips settled ground. *(Principal: "I get it bubbling up the same reviews every time I run and it doesn't seem to act on them.")* | test:reflectJob.test.ts (a finding already open/decided is NOT re-raised; a fresh finding is; high-confidence additive auto-applies) — none-yet | REVIEW-18; REFLECT-4,5,8; JOBS-6,9 |
| REFLECT-15 | must     | **Randomized / SEEDED coverage — don't fixate on the same nodes.** REFLECT-2's adaptive sampling in practice keeps hitting the same areas; a run MUST take a **deliberately stochastic** approach — pick its starting nodes/area via an **injectable random seed** (per-run, **recorded in the journal** for auditability/replay), so successive runs cover **different** regions and coverage genuinely accrues. The seed is **injected in evals** (deterministic per SPEC-0011 ULID/`Date.now` injection + EVAL-2) but **random in production**. Combine random sampling with the recency/churn + aged-area bias (REFLECT-2) — randomness is the anti-fixation floor, not the only signal. *(Principal: "make sure it takes a somewhat random approach — seed the prompt, or give it a way to randomly pick things in the KB to start, else it just hits the same ones.")* | test:reflectJob.test.ts (two runs with different seeds start from different areas; a fixed seed reproduces) — none-yet | REFLECT-2,8; EVAL-2; ENG (seed injection) |
| REFLECT-16 | should   | **Focused modes (or sibling jobs) — not one blurry pass.** Reflect's work splits into distinct, **independently schedulable** focuses, each with its own cadence + work-depth (JOBS-16/17): **(1) entity dedup/merge** (find nodes that are the same real thing — name variants like a short name ⊂ its fuller form — and propose a Review-gated merge, REFLECT-5/13), **(2) missing-link discovery** (REFLECT-3 lost/absent connections), **(3) redundant-link pruning** (collapse duplicate/near-duplicate links), **(4) random-area audit** (REFLECT-15 stochastic sweep). Model them as **modes of the Reflect job or sibling jobs on the unified engine** (JOBS-16) — the Principal can tune/enable each separately. Each is stateful (REFLECT-14) + seeded (REFLECT-15). The **dedup mode is eval-backed** (SPEC-0042 EVAL-13). *(Principal: "different modes, or we can split to different jobs… randomly picking areas, redundant links, new missing links… e.g. 'caroline' and 'caroline winters azzone' should be deduped.")* | none-yet | JOBS-16,17; REFLECT-3,5,14,15; EVAL-13 |
| REFLECT-17 | must     | **Reflect must achieve REAL coverage — not ~2% of the KB.** Live evidence (Principal's vault): one Reflect run inspected **15 of 1017 nodes** and the job has run **~twice total** → the vast majority of the KB is **never examined**, so "does it find new areas?" is *barely*. Reflect MUST traverse the KB at a meaningful rate: a **real cadence** (runs regularly, JOBS-2, not once-ever), an **adequate slice size**, **seeded-random + cursor rotation** (REFLECT-2/15) so each run covers **new** ground, and a **catch-up/backfill sweep** for the existing corpus (mirrors COMPOSE-9). Coverage is a **measurable target** (every node examined within a bounded staleness / N runs) and is **surfaced in Status** so "is Reflect actually doing anything?" is answerable at a glance. *(Principal: "I'm skeptical Reflect really works at all — how does it know to find new areas, does it track its runs?")* | test:reflectJob.test.ts (cursor advances across runs to cover new nodes; a coverage metric is emitted) — none-yet | REFLECT-2,8,15; JOBS-2; OBS-5; EVAL-13 |
| REFLECT-18 | must     | **A Reflect run MUST be robust — a malformed agent-output parse never crashes the run.** Live dev-log: a Reflect run **died** — `job.failed … SyntaxError: Expected property name or '}' in JSON` — the agent's output failed `JSON.parse` and took the **whole run down**, leaving no findings (a concrete reason it "doesn't seem to work"). A run MUST **tolerate malformed/partial agent output**: parse defensively, **salvage** valid findings, **audit** the parse failure, set-aside the bad item, and **complete the run** — never an uncaught throw. (Robust-to-malformed-data, ENG-15/16, applies to **agent outputs**, not just views.) | test:reflectJob.test.ts, reflectAgent.test.ts (a malformed agent-output line is salvaged/skipped, the run completes + audits the parse error, no uncaught throw — fails-before on the raw `JSON.parse`) — none-yet | ORCH-7; ENG-12,15,16; REFLECT-1,8 |
| REFLECT-19 | must     | **Reflect is the concurrency reconciler** (SPEC-0044): the **duplicate entities + missed cross-links** that **concurrent Connect** can transiently produce are **first-class Reflect targets** — the same classes REFLECT-3 (missing/lost connections) + REFLECT-5 (merge/consolidate, via Connect's merge machinery) already detect/repair, now a **declared dependency** of stage concurrency (CONCUR-3). These gaps occur **even serially** (Connect is imperfect), so this is an *existing* mandate concurrency only raises the rate of. Reflect's **reconciliation cadence scales with ingestion-rate / concurrency** so transient inconsistency **converges in bounded time** (not eventually-someday) without Reflect itself becoming the bottleneck | none-yet | SPEC-0044 CONCUR-3; REFLECT-3,4,5,11 |

## 5. Open questions

- [x] **Confidence/risk rubric** — RESOLVED: a **configurable posture** (REFLECT-12) — Guarded
      default (destructive→Review, additive auto above confidence), Autonomous opt-in. The
      additive confidence *cutoff* stays **agent-judged** in v1 (no fixed numeric threshold).
- [x] **Emergent-topic detection** — RESOLVED: **lean on the LLM** over the working set; cheap
      existing signals may *inform* selection, but **no embeddings / no preprocessing**.
- [x] **Consolidation semantics** — RESOLVED: reuse **Connect's merge machinery** (repoint
      claims, delete loser) behind a **Review** gate (REFLECT-5).
- [ ] **"Stale" signal thresholds** — prefilter+confirm is settled (mostly metadata, not
      deletion); the concrete signals/windows (age since last claim/link, inbound count) still
      need pinning for the impl mission.
- [ ] **Working-set size / cadence defaults** — slice size + runs/day defaults before the
      Principal tunes them.

## 6. Changelog

- 2026-06-08 — **REFLECT-14/15/16: stateful + seeded-random + focused-modes (Principal — "not satisfied with statefulness and effectiveness").** Live: Rumination **re-raises the same reviews every run and doesn't act**, and **fixates on the same nodes**. REFLECT-14 = stateful (consult open reviews + REVIEW-18 decisions, never re-raise an open/decided finding; act on high-confidence additively; the open review IS the state). REFLECT-15 = deliberately **seeded-random** area selection (injectable seed, journal-recorded; random in prod, injected in evals) so coverage stops fixating. REFLECT-16 = split into **focused modes/sibling jobs** (entity-dedup, missing-link discovery, redundant-link pruning, random-area audit) each independently schedulable (JOBS-16/17). Seed example the Principal gave: "caroline" vs "caroline winters azzone" should dedup → dedup mode is **eval-backed** (EVAL-13). Held for next-session impl per wind-down.
- 2026-06-01 — created (draft). First job on the Autonomous Jobs engine (SPEC-0023):
  scheduled **rumination** that wakes semi-regularly, takes a **bounded** working set
  (recency/churn or aged sampling via the job journal — **never a full-KB scan**), and looks
  for missed entities/claims, lost connections, emergent topics, stale nodes, and low-traction
  topics. **Additive high-confidence findings auto-apply (audited); destructive or
  low-confidence findings route to Review (SPEC-0018)**; deletions reach `main` via the
  deletion-aware gate (STAGING-10). Framed as a **DB-cleanup job, not a major event**.
  Named convergence point for deferred Reflect concerns (CONNECT-19, CLAIMS-17). Forks
  resolved with the Principal: **additive-auto / destructive→Review**; **no full scans**;
  **rich per-run journaling for cross-run awareness**.
- 2026-06-01 — **design walkthrough resolutions.** Autonomy is a **configurable posture**
  (REFLECT-12): Guarded default (destructive→Review) / Autonomous opt-in. **Grow-not-shrink**
  pinned (REFLECT-13): staleness = **metadata hygiene** (tags/labels/classifications); entity
  delete/merge is rare, Review-gated curation, never routine expiry. v1 scope adds **rare
  consolidation via Review** reusing **Connect's merge machinery**. Emergent topics: **lean on
  the LLM**, no embeddings/preprocessing. Working-set: **adaptive, journal-driven** (REFLECT-2).
  Runs **concurrently** (REFLECT-1 → ORCH-17/18), not idle-deferred. Still open: concrete
  "stale" signal thresholds; working-set size/cadence defaults.
- 2026-06-02 — **implemented slice 1** (detection + additive-auto + destructive→Review-raise) on the
  JOBS engine (SPEC-0023). `reflectAgent.ts`: a thin single-shot `copilot -p` decider over ONE
  bounded working set (no tools/SDK — single pass, per #43), returning findings (additive `writes`
  / destructive `review`); no fabrication (throws on bad output). `reflectJob.ts`: a `JobBehavior`
  that selects a **bounded** slice via the journal cursor (round-robin aged sampling + a churn hint
  when the KB grew; never the whole KB, REFLECT-2), runs the decider, and maps findings onto the
  engine's `JobFinding`s — the JobStage runner enforces posture (Guarded: additive-high-conf→auto,
  destructive/low-conf→Review; REFLECT-4/5/12), journals + audits (REFLECT-8), promotes additive
  outputs to `main` (REFLECT-7 additive). Registered `reflect` in `pipeline.ts`'s behavior resolver.
  Graduated REFLECT-1/2/3/4/5/6/8/9/10/12/13 → `test:`. Folded two JOBS follow-ups: JobStage
  `onExhausted` now bounded-re-advances the set-aside (mirrors #47's hardened Connect path).
- **Slice 2 (consolidation execution, REFLECT-5/7):** extracted the entity-merge core to
  `mergeNodes.ts` — ONE impl now shared by Connect's `connectOne` (resolve-time merge) and Reflect's
  approved consolidation (DRY; "reuses Connect's merge machinery"). `executeApprovedConsolidation.ts`
  runs a merge ONLY for a Review answered `verdict:'confirm'` whose markerKey is a consolidation plan
  (canonicalRel + loserRels) — never autonomously (REFLECT-5 safety envelope); advances the canonical
  under the shared lock via optimistic-advance, audits to `.kb/jobs/<id>/consolidations.jsonl`,
  idempotent (already-merged → no-op). `pipeline.ts answerActiveReview` dispatches an approved
  consolidation → execute + `promote`, so the loser deletions mirror to `main` via the deletion-aware
  gate (REFLECT-7). Graduated REFLECT-7 → `test:`. **Deferred:** REFLECT-11 convergence = later; the
  thin main-process `answerActiveReview` dispatch glue is covered via the unit-tested core +
  packaged-app e2e (the `active` singleton isn't unit-harnessed, mirroring the existing review
  dispatch).
