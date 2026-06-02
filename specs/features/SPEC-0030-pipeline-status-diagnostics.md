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
| OBS-1  | must     | A **diagnostic dev-log** subsystem — leveled (debug/info/warn/error) — captures exceptions/stack traces, **subprocess stdout+stderr**, git output, worktree lifecycle, lock waits, timings; **separate** from the audit log | test:app/src/kb/devlog.test.ts | ORCH-11; PRIN-5 |
| OBS-2  | must     | Dev logs live in `<vault>/.kb/cache/logs/` (gitignored, **never promoted**, rotated) **plus** a small **app-level log** in Electron userData for pre-vault/app errors | test:app/src/kb/devlog.test.ts | STAGING-6; DATA-9 |
| OBS-3  | must     | Dev-log entries **cross-reference** the audit (`runId`/`itemId`) so a structured audit failure links to its verbose diagnostic detail | test:app/src/kb/obsWiring.test.ts | AUDIT-1; ORCH-12 |
| OBS-4  | must     | Errors are **never silent**: every failure emits a **structured audit** event (set-aside, stage failed + attempt) **and** a dev-log entry with the cause | test:app/src/kb/obsWiring.test.ts | ORCH-12; AUTO-8; AUDIT-2 |
| OBS-5  | must     | A **Pipeline Status view** shows the **live** pipeline — per-stage state (idle/running/blocked/error), **queue depth**, **current item**, progress/throughput, overall state (running/idle/**stalled**) | test:app/src/shell/views/statusView.test.ts | ORCH-10; SHELL-1,2 |
| OBS-6  | must     | The Status view surfaces **recent errors** and **set-aside/poison items** prominently — each with reason + drill-down to the dev-log detail | test:app/src/shell/views/statusView.test.ts | ORCH-12; OBS-1 |
| OBS-7  | must     | The Status view exposes **worktree & lock state** — worktrees, their branches, and who holds/awaits the canonical-writer lock — so a stalled pipeline's cause is visible | test:app/src/shell/views/statusView.test.ts | ORCH-2,18; STAGING-1 |
| OBS-8  | should   | The view **live-updates** (poll ORCH-10 status + dev-log tail, or push) so progress/stall shows in near-real-time | test:app/src/shell/views/statusView.test.ts | ORCH-10 |
| OBS-9  | must     | The Status view is **read-only observation** — no mutating actions (retries/config live in Reviews / Control Panel) | test:app/src/shell/views/statusView.test.ts | AUDIT-8 |
| OBS-10 | should   | Dev-log **verbosity is configurable** (Settings; default info, debug to troubleshoot); logs are **redaction-aware** for captured text / egress payloads | test:app/src/kb/instanceConfig.test.ts, app/src/shell/views/settingsView.test.ts | AUTO-12; PRIN-19 |
| OBS-11 | should   | On a **stall** (no progress past a threshold with a non-empty queue), the view flags it clearly (optionally notifies) — turning silent "2 in queue" into a visible, explained state | test:app/src/shell/views/statusView.test.ts | ORCH-10,13 |
| OBS-12 | should   | Operations emit **timed spans** to the dev log — `{spanId, parentSpanId, op, itemId, stage, startTs, endTs, durationMs, outcome}` — that **nest** (a stage run wraps its Copilot-invocation + git/worktree spans), so elapsed time is **attributable to where it's spent** | test:app/src/kb/obsTracing.test.ts | ORCH-16; OBS-1 |
| OBS-13 | should   | **Copilot invocations are timed as first-class spans** (the dominant cost): each `copilot -p`/SDK call records duration + outcome, attributable per item/stage | test:app/src/kb/obsTracing.test.ts | ORCH-16 |
| OBS-14 | should   | A **derived perf index** aggregates spans (rebuildable, cached like the activity index): per-stage **throughput** (items/min), **Copilot latency** (avg/p50/p95), and a **where-time-goes** breakdown (% Copilot vs git vs other) | test:app/src/kb/perfIndex.test.ts | AUDIT-4; LIFE-9 |
| OBS-15 | should   | The status surface shows **latency & throughput** — per-stage throughput, recent **slow operations**, a Copilot-latency summary, and the time-breakdown — so the Principal can see **where time goes** | test:app/src/shell/views/statusView.test.ts | OBS-5; LIFE-9 |
| OBS-16 | should   | Spans support **end-to-end per-item tracing** (capture→archive→decompose→connect→claims→link) with per-hop durations — the "ingestion-to-link" latency is readable directly | test:app/src/kb/perfIndex.test.ts | OBS-12 |

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

- 2026-06-02 — **OBS-10 (configurable dev-log verbosity) → test:. SPEC-0030 now COMPLETE end-to-end.**
  Added `devLogLevel` (`info` default / `debug`) to the per-Instance config (`.kb/instance.json`,
  read/write/validate + safe-default), surfaced as a **Diagnostics** verbosity selector in the
  Settings view (benign info/debug toggle, applied directly, sends the full settings so the autonomy
  default isn't clobbered). `startPipeline` reads the level from the persistent staging instance
  config (best-effort; absent first-run → info) and passes it to `createVaultDevLog({level})` — a
  level change applies on the next pipeline start. The **redaction-aware** half (sensitive fields
  redacted unless `debug`) already shipped in OBS-1 (devlog.ts). Tested: `instanceConfig.test`
  (devLogLevel round-trip + unknown→info) + `settingsView.test` (the selector persists the full
  settings). With OBS-1/2/3/4 (dev log), OBS-12/13/14/16 (tracing), and OBS-5/6/7/8/9/11/15 (Status
  view) all on `main`, **every OBS requirement is `test:` — SPEC-0030 is done.**
- 2026-06-02 — **Status view (the UI half)** — **OBS-5/6/7/8/9/11/15 → test:**. A new read-only
  `statusView.ts` sidebar view (`VIEW_STATUS`, registered in views.ts/shell.ts), fed by a
  `kb:pipelineStatusView` IPC over `pipelineStatusForActive()` (pipeline.ts) which gathers per-stage
  queue depths + `busy()` flags, the canonical-writer `lock.state()` (new OBS-7 introspection on the
  Mutex), recent dev-log errors (`readRecentDevLogEntries`, OBS-6), the perf index (OBS-15), and the
  worktrees, handed to the pure `pipelineStatusView.ts` assembler (per-stage state + overall
  running/idle/**stalled** with a 5-min stall threshold, OBS-11). The view shows the stage flow,
  prominent stall banner, lock holder/waiters, recent errors with drill-down to the cause
  (runId/itemId cross-link), the Copilot-latency/throughput/where-time-goes/slow-ops breakdown, and
  the worktrees; it **live-updates** by polling (gated on visibility, OBS-8) and is **read-only**
  (OBS-9 — the only controls are error-drilldown toggles, asserted in the test). Unit-tested via the
  pure assembler/lock/devlog-reader tests + a happy-dom `statusView.test.ts` (render of every panel +
  the drill-down interaction + read-only + XSS-escaping). **SPEC-0030 is now complete end-to-end**
  except **OBS-10** (a Settings verbosity toggle — redaction already lands in the dev log; the toggle
  is a small separate Settings piece, left `none-yet`).
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
- 2026-06-02 — **slice 1a (dev-log subsystem)** merged (#58): `app/src/kb/devlog.ts` — in-house
  leveled + size-rotated JSONL, `.child({scope,runId,itemId})` binding, redaction-aware `sensitive`
  bag (full only at `debug`, OBS-10 minimal), never-throws, noop default. **OBS-1 → test:**.
- 2026-06-02 — **slice 1b (errors-never-silent wiring)**: the dev-log is threaded into all 5 stages
  (Orchestrator/Decompose/Claims/Connect/Job) as an optional `DevLog` ctor param (→ `noopDevLog`);
  every failure catch (`failed`/`setaside`/drain-error) now emits a `log.error`/`warn` carrying the
  same `runId`/itemId as its structured audit event (the OBS-3 cross-link), and the 4 CLI agent
  runners append subprocess **stderr** to the thrown error so the stage dev-log records the real
  cause. **OBS-3 + OBS-4 → test:** (`obsWiring.test.ts` verifies a Decompose failure end-to-end:
  audit `failed` event + a cross-linked `decompose.failed` dev-log entry with matching runId + the
  stderr-bearing cause; the identical catch-pattern is applied to claims/connect/archive/job).
  **No `pipeline.ts`/boot seam** in this PR. **Deferred to slice 1c:** OBS-2 — instantiating the two
  sinks (`<vault>/.kb/cache/logs/` + the app-level userData log) in `pipeline.ts`/`main.ts` + the
  boot-wrap of `initPipeline` (sequenced after the link-promotion + Reflect-2 work on `pipeline.ts`).
  The Status **view** (OBS-5/6/7/8/9/11) is a later slice (nav shell; coordinates with DEV-5 Activity).
- 2026-06-02 — **slice 1c (sinks + boot-wrap)** — **OBS-2 → test:**. The dev-log is now live in
  production: `pipeline.ts startPipeline` creates a per-vault `createVaultDevLog(<vault>/.kb/cache/logs/)`
  and threads it into all 5 stage ctors (+ JobScheduler→JobRunner) — so the OBS-3/4 failure logging
  from slice 1b actually writes. The boot path is wrapped: `startPipeline` logs a
  `startup.worktree-provision-failed` cause (re-throws unchanged) and `main.ts` wraps the
  fire-and-forget `void initPipeline()` to an **app-level** `createAppDevLog(<userData>/logs/app.log)`
  — turning the silent boot stall (the bug that motivated SPEC-0030) into a recorded cause. Sink
  locations are unit-tested (`devlog.test.ts`); the `pipeline.ts`/`main.ts` instantiation is
  main-process glue (verified by typecheck + e2e/manual, per the codebase's main-glue coverage stance).
  **SPEC-0030 slice 1 (the dev-log half: OBS-1/2/3/4) is complete**; the Status **view** (OBS-5–9/11)
  + latency tracing (OBS-12–16) remain later slices.
- 2026-06-02 — **slice 2a (latency tracing — data layer)** — **OBS-14 + OBS-16 → test:**. Two new
  modules: `app/src/kb/tracing.ts` — a `Tracer` of nestable timed spans
  (`{spanId, parentSpanId, op, itemId, stage, startTs, endTs, durationMs, outcome}`) appended to a
  never-promoted `<vault>/.kb/cache/spans.jsonl` (never-throws, mirrored to the dev log at `debug`,
  `noopTracer` default); and `app/src/kb/perfIndex.ts` — a rebuildable, cached (`.kb/cache/perf-index.json`,
  freshness on the spans-file stat) aggregation: Copilot latency avg/p50/p95 (OBS-13's cost),
  per-stage throughput (items/min), where-time-goes (Copilot vs other over the stage-run total), and
  recent slow ops; plus `spansForItem` for per-item end-to-end hops (OBS-16). **Forks resolved
  (open-Qs):** spans are a **parallel tracer**, NOT an extension of `AgentTrace` — `AgentTrace` stays
  audit-side, and a stage SYNTHESIZES the `copilot.invoke` span from the `decision.agent` trace it
  already gets, so the thin agents stay untouched and only stages carry a `Tracer` (the `DevLog`
  pattern); spans live in the diagnostics zone (`.kb/cache/`), aggregated over a **recent window**
  (default 5000), cache keyed on the spans-file stat (spans aren't committed → no git-HEAD poke).
  **Deferred to slice 2b (wiring):** OBS-12/13 — threading the `Tracer` into the 5 stages + pipeline.ts
  so real operations emit a `stage.run` span wrapping a synthesized `copilot.invoke` child (the
  proven DevLog threading). The Status **view** (OBS-5–9/11) + latency surfacing (OBS-15) follow.
- 2026-06-02 — **stage span emission (wiring)** — **OBS-12 + OBS-13 → test:**. The `Tracer` is now
  threaded into the 4 pipeline stages (`Orchestrator`/`Decompose`/`Connect`/`Claims`) + `pipeline.ts`
  (`createVaultTracer(vaultPath)`), the same optional-ctor-param pattern as the dev-log. Each stage
  drain opens a per-item `stage.run` span and passes it to the agent via a new `SpanCtx`
  (`decider(input, { span })`); the agent times its Copilot call as a **true nested `copilot.invoke`
  child** (`ctx.span.child(COPILOT_OP)`), capturing **failures too** (the span ends `error` before the
  decider re-throws / the archivist falls back). Children inherit `stage`+`itemId` for per-item tracing
  (OBS-16). The thin agents gained only an optional `ctx` param — no `Tracer` dependency. Verified
  end-to-end (`obsTracing.test.ts`): a real `makeDecomposeDecider` call under a stage span emits a
  nested copilot child (`parentSpanId` link, inherited stage/itemId, `ok`), a failed call ends `error`
  + re-throws, and the emitted spans feed the perf index. Existing stage tests unchanged (the new
  params default to `noopTracer`/`noopActiveSpan`). **The Status view (OBS-5–9/11) + latency surfacing
  (OBS-15) are the remaining slice** — the latency half's data + emission are now complete.
