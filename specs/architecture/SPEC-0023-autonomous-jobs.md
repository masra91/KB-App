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
| JOBS-1   | must     | A **job registry** records each autonomous job as `{id, type, schedule, enabled, config}`; the Principal can enable/disable and configure cadence | test:jobRegistry.test.ts | VISION-11; AUTO-12 |
| JOBS-2   | must     | Jobs run on a **recurring schedule** chosen from **named presets** ("a few times/day", "hourly", "daily", "off") + an enable toggle; raw-cron and **event-driven** triggers are later extensions the registry must not preclude | test:jobs.test.ts, jobScheduler.test.ts | LIFE-8 |
| JOBS-3   | must     | The orchestrator wakes a job as an **agent in its own worktree** (SPEC-0014 harness); its cognition + writes run **concurrently off a synced checkpoint**, and **only the canonical ff-advance serializes** (ORCH-17/18) — a job never blocks live capture/Enrich | test:jobStage.test.ts | ORCH-2,3,17,18; CANON-8 |
| JOBS-4   | must     | A job run is a **bounded pass** — a capped working set + cost/time budget that fits the agent context; **no job performs an unbounded full-KB scan** | none-yet | PRIN-5,16; VISION-8 |
| JOBS-5   | must     | Jobs run **concurrently with the live pipeline** under optimistic concurrency (ORCH-17/18/19): a stale-base canonical advance **re-syncs + retries** rather than blocking or corrupting canonical — a job never head-of-line-blocks capture/Enrich | test:jobStage.test.ts | ORCH-17,18,19 |
| JOBS-6   | must     | **Single-flight**: a job never runs concurrently with itself; a scheduled fire during an in-progress run is skipped (or coalesced), not stacked | test:jobStage.test.ts, jobScheduler.test.ts | ORCH-10,13 |
| JOBS-7   | must     | Every run keeps a **per-job run-state journal** — operational memory (last-visited areas, cursors, counters) at **`.kb/jobs/<job>/journal.jsonl`**, **versioned on `staging`** (git-auditable, **never promoted to `main`**, hidden from Obsidian), **not** a Source/Entity — read by the next run for continuity/awareness | test:jobStage.test.ts | DATA-1,10; PRIN-5 |
| JOBS-8   | must     | Every run emits a **rich audit event** — what it inspected, found, did, and **deferred to Review**, with the agent's reasoning (the *why*), per AUTO-8 | test:jobStage.test.ts | AUTO-8; LIFE-9 |
| JOBS-9   | must     | Every job action carries a **disposition** (silent / notify / approve-first) by risk+confidence+reversibility; **additive high-confidence auto-applies**, **destructive or low-confidence routes to the Review queue** | test:jobs.test.ts, jobStage.test.ts | AUTO-3,7,10 |
| JOBS-10  | must     | A job takes **no external side-effecting action** (read-only w.r.t. the world); within-KB additive writes are audited and **sink-confined** — agent-emitted write paths are contained to the KB knowledge roots (no escape via `..`/absolute/symlink) and the per-job `id` cannot traverse the filesystem (`journalRel`/worktree/branch), so a job can never write outside the KB | test:jobStage.test.ts, jobRegistry.test.ts | AUTO-6 |
| JOBS-11  | must     | Each job has a **manual "run now"** trigger that runs one bounded pass on demand (a test/inspection affordance); it **respects single-flight** and the same concurrency rules as a scheduled run | test:jobScheduler.test.ts | LIFE-9 |
| JOBS-12  | must     | A job's writes publish to `main` via the **promotion gate**; retire/consolidate **deletions propagate** via deletion-aware promotion (STAGING-10); `main` is never left half-written | test:jobStage.test.ts | STAGING-3,10; CANON-1,3 |
| JOBS-13  | should   | Job runs are **restartable/crash-safe**: an interrupted run leaves the KB consistent (branch state is truth), mirroring ORCH-13/STAGING-8 | none-yet | ORCH-13; STAGING-8 |
| JOBS-14  | should   | Per-job config (schedule, enabled, knobs) is **editable later via the Control Panel** (VISION-11); v1 may expose a minimal Settings surface | test:jobRegistry.test.ts | VISION-11 |
| JOBS-15  | must     | Each job has a configurable **autonomy posture** with a **safe default**: **Guarded** (additive auto; destructive/low-confidence → Review) by default; the Principal may opt a job into **Autonomous** (agent judgment governs all dispositions). Part of per-job config | test:jobs.test.ts, jobRegistry.test.ts | AUTO-3,7,12 |
| JOBS-16  | must     | **One job model, two facings — a researcher is just an externally-facing job.** Every job carries a **`facing: internal \| external`** attribute. **Internal** jobs are inward (operate on the KB itself — Reflect/Rumination, reconcile, maintenance): JOBS-10's no-external-egress holds as-is. **External** jobs are **researchers** (SPEC-0028) — they reach *outside* the KB under an **egress tier + scope/sensitivity gates** (SPEC-0028, SPEC-0043); for `external` jobs JOBS-10 relaxes to **read-only egress within the granted tier** (still **no side-effecting writes to the world**). Both facings share the **same registry, scheduler, single-flight, journal, autonomy posture, audit, promotion, and config surface** (JOBS-1..15, 17) — **the only difference is `facing`** (which gates egress). Researchers are **not a separate subsystem**; they are external jobs on this engine (as Reflect is an internal one). *(Principal: "a job is a cron that is inward facing and a researcher is a job that is externally facing — consistency is key, only difference is inward vs outward facing.")* | test:app/src/kb/jobRegistry.test.ts, app/src/kb/jobsPanel.test.ts | SPEC-0028; SPEC-0043; AUTO-6; JOBS-1,10 |
| JOBS-18  | should   | **The Principal can author their OWN jobs.** Today the only jobs are built-ins (Reflect, researchers, intake) — *"there are no other jobs."* On the unified engine (JOBS-16), the Principal can **create a custom job**: a **name + prompt/instruction + `facing` (internal\|external) + schedule (JOBS-2 presets) + work-depth (JOBS-17) + autonomy posture (JOBS-15)** — registered like any built-in, run/scheduled/journaled/audited **identically**, and managed in the Control Panel (SPEC-0027). The built-ins (Reflect's modes, researchers) become **instances of the same authorable shape**, not a separate class — so "collapse jobs and researcher" falls out of the model (a researcher = an `external` user/built-in job). All guardrails still hold: `internal` = no egress (JOBS-10); `external` = egress tier + SENSE gates (SPEC-0043); disposition/autonomy per JOBS-9/15. *(Principal: "no other jobs — should we collapse jobs and researcher, or people should be able to make their own jobs.")* | none-yet | JOBS-1,2,15,16,17; SPEC-0027; SPEC-0028; SPEC-0043 |
| JOBS-17  | must     | **Configurable work-depth is UNIFORM across all jobs AND all agents — not researcher-only.** Today the **depth / effort budget** (tool-call ceiling, recursion/hops depth, orient budget — SPEC-0028 `maxToolCalls`/`orientBudget`/depth) is exposed **only for researchers**; JOBS-4 gives every job a *generic* bounded budget but no Principal-facing knob. It MUST become a **first-class, Principal-configurable "work depth" control on every job (internal + external) AND every stage agent** (Decompose/Connect/Claims/Reflect — SPEC-0014) — one consistent *"how hard does this work each item"* knob (depth/iterations + tool-call/time ceiling), part of per-job/per-agent `config` (JOBS-1). **Safe default** per agent/job; the Principal may **opt into higher depth with a warning** (mirrors the per-stage concurrency ruling, SPEC-0044/CONCUR — deeper = more thorough but more cost/time), and the **global Copilot ceiling (ORCH-23) stays the hard wall** — depth scales **per-item effort, never total parallelism**, so it can't blow the safety bound. Surfaced + editable in the **Control Panel** (JOBS-14 / SPEC-0027 PANEL). Researchers' existing budget becomes the **external-facing instance of this one knob**, not a parallel mechanism. *(Principal: "configurable work depth for all the agents and jobs too — why just researcher? consistency is key.")* | test:app/src/kb/workDepth.test.ts, app/src/kb/jobRegistry.test.ts | JOBS-1,4,14; SPEC-0028 RESEARCH-15,17; SPEC-0014 ORCH-20,23; SPEC-0044; SPEC-0027; PRIN-5 |

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
- [x] **Autonomy-posture scope** — RESOLVED for v1: **per-job** (JOBS-15 is part of per-job
      config). A per-Instance default/override is **additive later** (routed to KB-Lead for the
      safety/product model) and the registry shape doesn't preclude it.

## 6. Changelog

- 2026-06-09 — **JOBS-16/17 slice 1 IMPLEMENTED (KB-Developer-4 → PR #328, → KB-QD-2).** Foundational
  model + the reusable depth interface. **JOBS-17 keystone** `kb/workDepth.ts`: one `WorkDepth` knob —
  a work-kind declares a `WorkDepthSpec` (default level + per-level profiles + hard per-item ceiling);
  `resolveWorkDepth` returns a concrete, clamped `ResolvedWorkDepth` with an opt-in-deeper **warning**.
  Per-item effort ONLY — the global Copilot ceiling (ORCH-23) stays the SEPARATE hard wall. Pure + no
  deps, built to be consumed by DEV-3 (Reflect coverage) / DEV-7 (recall budget). **JOBS-16** `facing`
  on `JobConfig` (default `internal`=no-egress; `external`=researcher), declared per built-in on the
  catalog (`facingForType`), validated at the registry boundary (unknown→internal), surfaced on
  `JobView`. Registry read/patch validate+sanitize `facing`+`workDepth`; `JobConfigPatch` exposes the
  editable `workDepth`. **Deferred to slice 2:** wiring `resolveWorkDepth` into the stage agents
  (Decompose/Connect/Claims/Reflect) + the researcher-budget migration + the Control-Panel depth-editor
  UI; **JOBS-18** (user-authored jobs) follows.
- 2026-06-08 — **JOBS-16/17: unify the job model (facing) + make work-depth configurable everywhere (Principal).**
  The Principal's consistency call: *"a job is a cron that is inward facing and a researcher is a job that is
  externally facing — and I want configurable work depth for all agents and jobs, not just researchers."*
  **JOBS-16** adds `facing: internal | external` so a researcher (SPEC-0028) is literally an external-facing job
  on the same engine (egress relaxes JOBS-10 to read-only-within-tier; Reflect is the internal case) — researchers
  stop being a parallel subsystem. **JOBS-17** generalizes the researcher-only depth/budget (`maxToolCalls`/
  `orientBudget`/depth) into one Principal-configurable **work-depth** knob on every job AND every stage agent
  (Decompose/Connect/Claims/Reflect), safe-default + opt-in-higher-with-warning, with the global Copilot ceiling
  (ORCH-23) still the hard wall (depth = per-item effort, not parallelism). Sibling to per-stage concurrency
  (SPEC-0044); surfaced in the Control Panel (SPEC-0027).
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
- 2026-06-02 — **implementation design finalized (PM-greenlit; impl gated on ORCH slice-1).**
  The v1 build (mostly NEW files, to minimize collision with the in-flight ORCH `*One` refactor):
  - **`jobRegistry.ts`** — `{id, type, schedule, enabled, config}` (JOBS-1) persisted per-vault at
    **`.kb/jobs/registry.json`** (tracked on `staging`, Settings-editable via IPC, JOBS-14). NOT
    app-global config — jobs are per-vault.
  - **`jobScheduler.ts`** (main process) — a tick loop mapping **named presets** → cadence
    (few-times/day · hourly · daily · off, JOBS-2) + enable toggle; fires each enabled+due job
    with a per-job **single-flight** guard (JOBS-6). Started from `pipeline.ts` `startPipeline`
    (the one file shared with the ORCH work — sequenced after it).
  - **`JobStage`** — reuses the SPEC-0014 harness (like the Enrich stages): wakes an agent in the
    job's worktree on `staging`, runs one **bounded pass** (JOBS-4; the job-type's pluggable
    behavior), commits findings, and ff-advances under the shared canonical-writer lock using the
    **optimistic re-sync+retry** path (JOBS-3,5 → ORCH-17/18/19 — the gate this impl waits on),
    then the **deletion-aware promotion hook** (SPEC-0021 STAGING-10) publishes `staging`→`main`
    (JOBS-12). Per-job **journal** at `.kb/jobs/<job>/journal.jsonl`, read for continuity (JOBS-7).
  - **Disposition** (JOBS-9): additive high-confidence → auto on `staging` (audited); destructive
    or low-confidence → Review queue (SPEC-0018). **Autonomy posture per-job** (JOBS-15;
    per-Instance deferred — see §5). **Run-now** (JOBS-11) via IPC = one bounded pass, single-flight.
  - **Engine vs. behavior:** this ships the *mechanism* + a deterministic **example/test job** so
    the harness is testable without Reflect; the first real job (Reflect) lands with SPEC-0024.
  - **Constraint check:** `.kb/jobs/` needs **no `.gitignore` change** — the vault gitignore
    ignores only `.kb/cache/` (vault.ts), so `.kb/jobs/` is tracked on `staging` by default, and
    `EVERGREEN_PATHS` (`sources`/`entities`/`claims`) excludes it → never promoted, hidden from
    Obsidian on `main` (JOBS-7).
