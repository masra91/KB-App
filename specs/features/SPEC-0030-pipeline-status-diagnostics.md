---
spec: SPEC-0030
key: OBS
title: Pipeline Status & Diagnostics (live status view + dev logs)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0006, SPEC-0014, SPEC-0017, SPEC-0021, SPEC-0027, SPEC-0029]
stage: Cross-cutting
supersedes: null
---

# Pipeline Status & Diagnostics (live status view + dev logs)

> Make "what's the pipeline doing, and **why is it stuck?**" answerable at a glance. Two parts:
> (1) a **diagnostic dev-log** on disk — verbose runtime errors, subprocess stderr, git/worktree/
> lock detail — **separate** from the knowledge audit; and (2) a **live Pipeline Status view** —
> stage flow, queue depth, current item, progress, **recent errors**, set-aside items, and
> **worktree/lock state**. Read-only. Complements Audit (SPEC-0029): Audit = *what happened*
> (curated history); Status = *what's happening now + where it broke*.

## 1. Intent (the why / JTBD)

The pipeline runs autonomously across hidden git worktrees. When it stalls — *"2 in queue,
nothing happened"* — the cause (a failed worktree provision, a Copilot subprocess error, a lock
wait) is **invisible**: the packaged app swallows console output and the worktree machinery is
opaque. JTBD: *"show me the pipeline's live state and surface exactly where and why it got
stuck — without me reading code or hunting through git worktrees."*

## 2. Audit vs. dev log (the split)

| | **Audit** (SPEC-0029) | **Dev/diagnostic log** (this spec) |
| --- | --- | --- |
| Records | *knowledge* lineage — what happened + why | *operational* diagnostics — exceptions, **subprocess stdout/stderr**, git output, worktree lifecycle, lock waits, timings |
| Shape | structured, per-item, curated, immutable | verbose, **leveled** (debug/info/warn/error), **rotated** |
| Where | in the vault; some promoted to `main` | working zone `.kb/cache/logs/` (gitignored, **never promoted**) + app-level log in userData |
| Failures | **structured** events (set-aside, stage failed, attempt N) | the **verbose cause** (stack/stderr) behind them |

They **cross-link by `runId`/`itemId`**: an audit "source X set aside after 3 attempts" → the
dev-log stack trace + Copilot stderr that explains it. Stack traces and subprocess noise stay
**out of the KB/Obsidian/`main`**.

## 3. The diagnostic dev-log

- **Leveled + rotated** runtime log capturing: exceptions/stack traces, **Copilot CLI/SDK
  subprocess stdout+stderr**, git command output & failures, worktree create/sync/prune,
  canonical-writer lock acquire/wait/release, stage timings, promotion results.
- Lives at **`<vault>/.kb/cache/logs/`** (per-vault, co-located with the worktrees/state it
  describes; gitignored; never promoted; rotated by size/age), **plus** a small app-level log in
  Electron userData for errors **before a vault is open** (e.g. setup/worktree-provision
  failures).
- **Redaction-aware**: captured text and egress payloads are redacted at higher log levels
  (PRIN-19); verbosity is configurable in Settings (default `info`, `debug` to troubleshoot).

## 4. The live Pipeline Status view

A sidebar view (SPEC-0017), read-only:
- **Stage flow** — Capture → Archive → Decompose → Connect → Claims → Promote, each
  `idle / running / blocked / error`, with **progress bars** + throughput.
- **Queue depth** per stage + **current item** processing.
- **Pipeline state** — running / idle / **stalled** (last-activity timestamp).
- **Recent errors** (from the dev log) + **set-aside / poison items** (ORCH-12), each with reason
  + drill-down to the dev-log detail.
- **Worktree & lock state** — which worktrees exist, the branch each is on, who **holds/awaits**
  the canonical-writer lock — so a stall's cause is visible.
- **Latency & throughput** — per-stage throughput, **Copilot-call latency** (avg/p50/p95),
  recent **slow operations**, and a **where-time-goes** breakdown (most of it is Copilot
  invocations) — so the minutes-long ingestion→link delay is explained, not mysterious.

## 5. Requirements

| ID     | Priority | Statement (short)                                                                   | Verify   | Traces |
| ------ | -------- | ----------------------------------------------------------------------------------- | -------- | ------ |
| OBS-1  | must     | A **diagnostic dev-log** subsystem — leveled (debug/info/warn/error) — captures exceptions/stack traces, **subprocess stdout+stderr**, git output, worktree lifecycle, lock waits, timings; **separate** from the audit log | none-yet | ORCH-11; PRIN-5 |
| OBS-2  | must     | Dev logs live in `<vault>/.kb/cache/logs/` (gitignored, **never promoted**, rotated) **plus** a small **app-level log** in Electron userData for pre-vault/app errors | none-yet | STAGING-6; DATA-9 |
| OBS-3  | must     | Dev-log entries **cross-reference** the audit (`runId`/`itemId`) so a structured audit failure links to its verbose diagnostic detail | none-yet | AUDIT-1; ORCH-12 |
| OBS-4  | must     | Errors are **never silent**: every failure emits a **structured audit** event (set-aside, stage failed + attempt) **and** a dev-log entry with the cause | none-yet | ORCH-12; AUTO-8; AUDIT-2 |
| OBS-5  | must     | A **Pipeline Status view** shows the **live** pipeline — per-stage state (idle/running/blocked/error), **queue depth**, **current item**, progress/throughput, overall state (running/idle/**stalled**) | none-yet | ORCH-10; SHELL-1,2 |
| OBS-6  | must     | The Status view surfaces **recent errors** and **set-aside/poison items** prominently — each with reason + drill-down to the dev-log detail | none-yet | ORCH-12; OBS-1 |
| OBS-7  | must     | The Status view exposes **worktree & lock state** — worktrees, their branches, and who holds/awaits the canonical-writer lock — so a stalled pipeline's cause is visible | none-yet | ORCH-2,18; STAGING-1 |
| OBS-8  | should   | The view **live-updates** (poll ORCH-10 status + dev-log tail, or push) so progress/stall shows in near-real-time | none-yet | ORCH-10 |
| OBS-9  | must     | The Status view is **read-only observation** — no mutating actions (retries/config live in Reviews / Control Panel) | none-yet | AUDIT-8 |
| OBS-10 | should   | Dev-log **verbosity is configurable** (Settings; default info, debug to troubleshoot); logs are **redaction-aware** for captured text / egress payloads | none-yet | AUTO-12; PRIN-19 |
| OBS-11 | should   | On a **stall** (no progress past a threshold with a non-empty queue), the view flags it clearly (optionally notifies) — turning silent "2 in queue" into a visible, explained state | none-yet | ORCH-10,13 |
| OBS-12 | should   | Operations emit **timed spans** to the dev log — `{spanId, parentSpanId, op, itemId, stage, startTs, endTs, durationMs, outcome}` — that **nest** (a stage run wraps its Copilot-invocation + git/worktree spans), so elapsed time is **attributable to where it's spent** | none-yet | ORCH-16; OBS-1 |
| OBS-13 | should   | **Copilot invocations are timed as first-class spans** (the dominant cost): each `copilot -p`/SDK call records duration + outcome, attributable per item/stage | none-yet | ORCH-16 |
| OBS-14 | should   | A **derived perf index** aggregates spans (rebuildable, cached like the activity index): per-stage **throughput** (items/min), **Copilot latency** (avg/p50/p95), and a **where-time-goes** breakdown (% Copilot vs git vs other) | none-yet | AUDIT-4; LIFE-9 |
| OBS-15 | should   | The status surface shows **latency & throughput** — per-stage throughput, recent **slow operations**, a Copilot-latency summary, and the time-breakdown — so the Principal can see **where time goes** | none-yet | OBS-5; LIFE-9 |
| OBS-16 | should   | Spans support **end-to-end per-item tracing** (capture→archive→decompose→connect→claims→link) with per-hop durations — the "ingestion-to-link" latency is readable directly | none-yet | OBS-12 |

## 6. User flows / surface

- Open **Pipeline Status** → see Archive `blocked — error`, queue depth 2, last activity 4m ago
  → click the error → dev-log: *"staging worktree provision failed: <git error>"*. Stuck cause
  found in seconds.
- A source set aside after 3 Decompose attempts → shown in the view with reason → drill into the
  Copilot stderr.

## 7. Out of scope (for now)

- **Interactive recovery** (retry/skip/unstick from the view) — read-only v1; retries live in the
  pipeline / Reviews. (A natural follow-up.)
- **Remote/centralized log shipping** — local on-disk only.
- **Long-horizon trend dashboards / historical analytics** — v1 covers **current + recent**
  latency/throughput (OBS-14/15); cross-week trends, charts, and SLA tracking are later.
- **Replacing audit** — audit keeps structured events; this adds the verbose diagnostic layer.

## 8. Open questions

- [ ] **Log library vs hand-rolled** — a tiny dependency (pino/winston) vs a minimal in-house
      leveled+rotated logger (E1: fewer deps). Lean in-house/minimal.
- [ ] **Status surface mechanism** — does the renderer poll an IPC `pipelineStatus` (ORCH-10
      exists) + tail the dev log, or does main push updates over a channel?
- [ ] **Stall threshold** — how long with a non-empty queue before "stalled" (per-stage vs
      global)?
- [ ] **Worktree/lock introspection** — expose lock holder/waiters from `stageLock`/orchestrator
      to the UI (needs a small status hook).
- [ ] **Redaction policy** — exactly what's redacted at which level (captured text, file paths,
      egress payloads).
- [ ] **Span volume / retention** — tracing every op can be high-volume; sampling vs full, and
      how long the **perf index** keeps spans (recent window vs full) (OBS-12/14).
- [ ] **Span model reuse** — extend the existing `AgentTrace` (ORCH-16, already times model
      invocations) into the general span shape, vs a parallel tracer.

## 9. Changelog

- 2026-06-02 — created (draft). Operational observability, split from knowledge audit: a
  **diagnostic dev-log** (leveled/rotated, subprocess stderr + git/worktree/lock detail, in
  `.kb/cache/logs/` + an app-level log, never promoted, cross-linked to audit by runId/itemId)
  and a **live Pipeline Status view** (stage flow, queue depth, current item, progress, recent
  errors, set-aside items, **worktree/lock state**, stall detection). Read-only; complements
  SPEC-0029 (Audit = history, Status = now/why-stuck). Forks resolved with the Principal:
  **separate views in one obs spec**, **dev logs in vault `.kb/cache/logs/` + app log**, **full
  dashboard v1**. Motivated directly by a stuck-pipeline test session where the cause was
  invisible.
- 2026-06-02 — **latency/throughput tracing (OBS-12..16).** Added **span-based timing** (nested,
  attributable; **Copilot invocations as first-class spans** — the dominant cost, building on
  ORCH-16's model-invocation timing), a **derived perf index** (per-stage throughput, Copilot
  latency p50/p95, where-time-goes %), **latency/throughput in the status surface**, and
  **end-to-end per-item tracing** (capture→…→link, per-hop durations). Motivated by a surprising
  ingestion→link delay measured at **~10–15s per Copilot call × dozens per rebuild** — the
  Principal wants to *see* where the time goes (and later aggregate it in the obs views).
