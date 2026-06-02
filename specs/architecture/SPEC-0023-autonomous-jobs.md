---
spec: SPEC-0023
key: JOBS
title: Autonomous Jobs & Scheduler
type: architecture
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-01
updated: 2026-06-01
related: [SPEC-0006, SPEC-0014, SPEC-0018, SPEC-0019, SPEC-0021, SPEC-0024]
supersedes: null
---

# Autonomous Jobs & Scheduler

> The engine for **autonomous enrichment**: recurring, agent-driven jobs the Principal
> configures, which the orchestrator wakes **on a schedule** to do bounded, KB-wide work
> with no per-event trigger. Generalizes the SPEC-0014 stage-harness from *"react to one new
> source"* to *"wake periodically, look at the KB, maybe improve it."* Think **database
> cleanup jobs** — frequent, small, low-drama, richly audited — not major events. The first
> job is **Reflect / Rumination (SPEC-0024)**; later jobs (Proactive Intake, scheduled
> Research/recooks) reuse this contract.

## 1. Intent (the why / JTBD)

The live pipeline is **event-driven**: a capture lands → it flows through Enrich. But some
work has no per-event trigger — it emerges from the KB *as a whole, over time*: structure
ingestion missed, connections never made, topics that went stale. SPEC-0004 Stage 6
(**Reflect**) and several deferred concerns across SPEC-0015/0016/0020 ("a later Reflect
recook") need a **scheduled, autonomous** way to run an agent over the KB.

The job the Principal hires this for: *"quietly keep my KB healthy and complete without me
asking — on a cadence I control, with a full record of what was done and why, and never
doing anything risky behind my back."* The trigger is **time** (a schedule), not a new
source; the payoff is a KB that **gets better on its own** as it grows (VISION, LIFE-8).

This spec owns the **mechanism** (registry, schedule, wake, bounding, audit, disposition
routing). The **behavior** of any one job lives in that job's own spec (Reflect = SPEC-0024).

## 2. Scope

**In scope (v1):**
- A **job registry**: each autonomous job has `{ id, type, schedule, enabled, config }`.
- **Recurring schedules** — interval/cron-style (e.g. several times/day). The Principal
  enables/disables and sets cadence (Settings v1; Control Panel later, VISION-11).
- The **orchestrator wakes a job as an agent in its own worktree** (the SPEC-0014 harness),
  serialized under the canonical-writer lock when it writes; jobs work on `staging`, results
  publish via the promotion gate (SPEC-0021).
- **Bounded passes**, **concurrent** execution (optimistic, ORCH-17/18), **single-flight** (no self-overlap).
- **Rich audit** + a **per-job run-state journal** (operational memory, not KB content).
- A **manual "run now"** trigger per job (also a test/validation affordance, cf. Replay).
- **Disposition routing** (silent / notify / approve-first) per SPEC-0006 AUTO.

**Out of scope (for now):**
- **Event-driven triggers** (run on KB change / on-idle signals) — v1 is schedule + manual;
  event-driven is a later extension (the registry leaves room for it).
- The **full Control Panel UI** (VISION-11) — v1 exposes config via Settings; the rich
  multi-job management surface is PANEL's job.
- **Parallel multi-job orchestration** sophistication (priorities, fairness) — v1 runs jobs
  serially under the existing lock.
- **External side-effecting actions** — forbidden entirely (AUTO-6); jobs are read-only
  w.r.t. the world.

## 3. The contract (how a job runs)

```
scheduler tick (or "run now"):
  for each enabled job whose schedule is due:
    if a run of this job is already in progress → skip (single-flight, JOBS-6)
    wake an agent in the job's worktree (SPEC-0014 harness) — runs CONCURRENTLY with the
    live pipeline (ORCH-17); only the canonical ff-advance serializes (JOBS-3 / ORCH-18):
      read the per-job journal (JOBS-7) for continuity ("what did I last look at?")
      do a BOUNDED pass (JOBS-4) — never an unbounded full-KB scan
      for each finding:
        additive + high-confidence → apply on `staging`, audited        (silent/notify)
        destructive OR low-confidence/high-risk → raise to Review        (approve-first)
      append an audit event + update the journal (what looked at / found / deferred)
    promote `staging` → `main` via the gate (deletion-aware, STAGING-10)
```

A job run **may do nothing** — finding no actionable work is a normal, common outcome.

## 4. Requirements

| ID       | Priority | Statement (short)                                                                 | Verify   | Traces |
| -------- | -------- | --------------------------------------------------------------------------------- | -------- | ------ |
| JOBS-1   | must     | A **job registry** records each autonomous job as `{id, type, schedule, enabled, config}`; the Principal can enable/disable and configure cadence | none-yet | VISION-11; AUTO-12 |
| JOBS-2   | must     | Jobs run on a **recurring schedule** chosen from **named presets** ("a few times/day", "hourly", "daily", "off") + an enable toggle; raw-cron and **event-driven** triggers are later extensions the registry must not preclude | none-yet | LIFE-8 |
| JOBS-3   | must     | The orchestrator wakes a job as an **agent in its own worktree** (SPEC-0014 harness); its cognition + writes run **concurrently off a synced checkpoint**, and **only the canonical ff-advance serializes** (ORCH-17/18) — a job never blocks live capture/Enrich | none-yet | ORCH-2,3,17,18; CANON-8 |
| JOBS-4   | must     | A job run is a **bounded pass** — a capped working set + cost/time budget that fits the agent context; **no job performs an unbounded full-KB scan** | none-yet | PRIN-5,16; VISION-8 |
| JOBS-5   | must     | Jobs run **concurrently with the live pipeline** under optimistic concurrency (ORCH-17/18/19): a stale-base canonical advance **re-syncs + retries** rather than blocking or corrupting canonical — a job never head-of-line-blocks capture/Enrich | none-yet | ORCH-17,18,19 |
| JOBS-6   | must     | **Single-flight**: a job never runs concurrently with itself; a scheduled fire during an in-progress run is skipped (or coalesced), not stacked | none-yet | ORCH-10,13 |
| JOBS-7   | must     | Every run keeps a **per-job run-state journal** — operational memory (last-visited areas, cursors, counters) at **`.kb/jobs/<job>/journal.jsonl`**, **versioned on `staging`** (git-auditable, **never promoted to `main`**, hidden from Obsidian), **not** a Source/Entity — read by the next run for continuity/awareness | none-yet | DATA-1,10; PRIN-5 |
| JOBS-8   | must     | Every run emits a **rich audit event** — what it inspected, found, did, and **deferred to Review**, with the agent's reasoning (the *why*), per AUTO-8 | none-yet | AUTO-8; LIFE-9 |
| JOBS-9   | must     | Every job action carries a **disposition** (silent / notify / approve-first) by risk+confidence+reversibility; **additive high-confidence auto-applies**, **destructive or low-confidence routes to the Review queue** | none-yet | AUTO-3,7,10 |
| JOBS-10  | must     | A job takes **no external side-effecting action** (read-only w.r.t. the world); within-KB additive writes are audited | none-yet | AUTO-6 |
| JOBS-11  | must     | Each job has a **manual "run now"** trigger that runs one bounded pass on demand (a test/inspection affordance); it **respects single-flight** and the same concurrency rules as a scheduled run | none-yet | LIFE-9 |
| JOBS-12  | must     | A job's writes publish to `main` via the **promotion gate**; retire/consolidate **deletions propagate** via deletion-aware promotion (STAGING-10); `main` is never left half-written | none-yet | STAGING-3,10; CANON-1,3 |
| JOBS-13  | should   | Job runs are **restartable/crash-safe**: an interrupted run leaves the KB consistent (branch state is truth), mirroring ORCH-13/STAGING-8 | none-yet | ORCH-13; STAGING-8 |
| JOBS-14  | should   | Per-job config (schedule, enabled, knobs) is **editable later via the Control Panel** (VISION-11); v1 may expose a minimal Settings surface | none-yet | VISION-11 |
| JOBS-15  | must     | Each job has a configurable **autonomy posture** with a **safe default**: **Guarded** (additive auto; destructive/low-confidence → Review) by default; the Principal may opt a job into **Autonomous** (agent judgment governs all dispositions). Part of per-job config | none-yet | AUTO-3,7,12 |

## 5. Open questions

- [x] **Schedule config granularity** — RESOLVED: **named presets** + enable toggle (JOBS-2);
      raw cron is a later escape hatch.
- [x] **Concurrency vs. idle** — RESOLVED: jobs run **concurrently** (optimistic, ORCH-17/18),
      not idle-deferred; stale-base advances re-sync + retry (JOBS-3,5).
- [x] **Journal location** — RESOLVED: **`.kb/jobs/<job>/journal.jsonl`**, versioned on
      `staging`, never promoted, hidden from Obsidian (JOBS-7).
- [x] **"Run now" vs. a live pipeline** — RESOLVED: respects single-flight + the same
      concurrency rules as a scheduled run (JOBS-11).
- [ ] **Event-driven v2** — which signals (KB-change, on-idle, post-replay) become triggers,
      and how they compose with schedules.
- [ ] **Autonomy-posture scope** — is Guarded-vs-Autonomous (JOBS-15) set per-job,
      per-Instance, or both? (AUTO-12.)

## 6. Changelog

- 2026-06-01 — created (draft). The mechanism for **autonomous enrichment**: a job registry +
  recurring scheduler that wakes agents (SPEC-0014 harness) for **bounded**, **concurrent**,
  **single-flight** KB-wide passes, with **rich audit + a per-job run-state journal** (memory
  outside the KB graph) and **disposition routing** (additive-auto / destructive-or-low-conf →
  Review) per SPEC-0006 AUTO, publishing via the SPEC-0021 deletion-aware gate. Framed as
  "DB-cleanup-job, not a major event." First consumer: Reflect / Rumination (SPEC-0024).
  Forks resolved with the Principal: **split scheduler (this) from the Reflect behavior
  (0024)**; **no full-KB scans** (bounded passes only); **rich per-run journaling**.
- 2026-06-01 — **design walkthrough resolutions.** Schedule = **named presets** (JOBS-2);
  **concurrent** execution under optimistic concurrency (JOBS-3,5 → ORCH-17/18/19), **not**
  idle-deferred; journal at **`.kb/jobs/<job>/journal.jsonl`** versioned on `staging` (JOBS-7);
  "run now" respects single-flight (JOBS-11); added **JOBS-15** configurable **autonomy
  posture** (Guarded default / Autonomous opt-in).
