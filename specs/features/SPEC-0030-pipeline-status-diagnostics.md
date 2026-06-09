---
spec: SPEC-0030
key: OBS
title: Pipeline Status & Diagnostics (live status view + dev logs)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-09
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

## 4a. Crash capture & resource/memory telemetry (the blind-spot a real crash exposed)

A packaged-app crash (2026-06-07, `EXC_BREAKPOINT`/`SIGTRAP` on a V8 `ThreadPoolForegroundWorker`
after ~2h uptime) surfaced a hard gap: **when the app dies natively, our diagnostics capture
nothing.** Forensics found (a) the macOS `.ips` had **no Application-Specific-Information** (no V8
fatal reason emitted), (b) `crashReporter` was **off** (no minidump), (c) there were **no
process-level crash handlers**, (d) the **app-level dev-log was never created** (the `<userData>/logs/`
sink from OBS-2 was absent in a live install), and (e) there is **no memory/resource telemetry** at
all — so a long-run memory climb (the prime suspect for a V8-worker trap) is invisible. The
*pipeline* dev-log did help (it showed a `decompose.failed` cascade + recurring `lock.stuck` around
the crash), which is exactly why we extend, not replace, this subsystem.

This section adds three things, all **local-only** (no egress, no telemetry upload — PRIN-19;
consistent with §7 "local on-disk only"):
- **Crash capture** — Electron's built-in `crashReporter` writing **local minidumps** (no upload)
  + JS process-level handlers (`uncaughtException`, `unhandledRejection`, and main-process
  `render-process-gone` / `child-process-gone` / `gpu-process-crashed`) that write a structured
  `fatal`/`crash` dev-log entry — reason + the **last runId/itemId/stage** — *before* exit. A native
  trap can't always be caught, but the breadcrumb + minidump turn "captured nothing" into "captured
  the last known state + a symbolicable dump."
- **Resource/memory telemetry** — periodic, low-overhead sampling of `process.memoryUsage()`
  (rss/heapUsed/heapTotal/external/arrayBuffers) and `app.getAppMetrics()` (per-process CPU/mem) into
  the dev-log + perf-index, so memory over a long run is a **trend**, not a mystery.
- **Leak / long-run watchdog** — detect sustained monotonic RSS/heap growth over a rolling window and
  emit a **loud, visible warn** (+ a Status-view memory readout); optional **heap-snapshot-on-threshold**
  (gitignored, for offline diffing). Turns a silent OOM-class trap into an early, visible signal.

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
| OBS-9  | must     | The Status view is **read-only observation** — no general mutating actions (config/retries live in Reviews / Control Panel). **Sole sanctioned exception: the OBS-17 set-aside recovery actions** (retry/dismiss on a poison item), which mutate via the stage-owned primitives, not the view | test:app/src/shell/views/statusView.test.ts | AUDIT-8; OBS-17 |
| OBS-10 | should   | Dev-log **verbosity is configurable** (Settings; default info, debug to troubleshoot); logs are **redaction-aware** for captured text / egress payloads | test:app/src/kb/instanceConfig.test.ts, app/src/shell/views/settingsView.test.ts | AUTO-12; PRIN-19 |
| OBS-11 | should   | On a **stall** (no progress past a threshold with a non-empty queue), the view flags it clearly (optionally notifies) — turning silent "2 in queue" into a visible, explained state | test:app/src/shell/views/statusView.test.ts | ORCH-10,13 |
| OBS-12 | should   | Operations emit **timed spans** to the dev log — `{spanId, parentSpanId, op, itemId, stage, startTs, endTs, durationMs, outcome}` — that **nest** (a stage run wraps its Copilot-invocation + git/worktree spans), so elapsed time is **attributable to where it's spent** | test:app/src/kb/obsTracing.test.ts | ORCH-16; OBS-1 |
| OBS-13 | should   | **Copilot invocations are timed as first-class spans** (the dominant cost): each `copilot -p`/SDK call records duration + outcome, attributable per item/stage | test:app/src/kb/obsTracing.test.ts | ORCH-16 |
| OBS-14 | should   | A **derived perf index** aggregates spans (rebuildable, cached like the activity index): per-stage **throughput** (items/min), **Copilot latency** (avg/p50/p95), and a **where-time-goes** breakdown (% Copilot vs git vs other) | test:app/src/kb/perfIndex.test.ts | AUDIT-4; LIFE-9 |
| OBS-15 | should   | The status surface shows **latency & throughput** — per-stage throughput, recent **slow operations**, a Copilot-latency summary, and the time-breakdown — so the Principal can see **where time goes** | test:app/src/shell/views/statusView.test.ts | OBS-5; LIFE-9 |
| OBS-16 | should   | Spans support **end-to-end per-item tracing** (capture→archive→decompose→connect→claims→link) with per-hop durations — the "ingestion-to-link" latency is readable directly | test:app/src/kb/perfIndex.test.ts | OBS-12 |
| OBS-17 | should   | **Interactive unblock** — for a stuck/errored stage, the Status view shows the **error message + the offending item** (drill-down to the dev-log) and offers **retry / set-aside / dismiss**, so the Principal can clear a poison-loop without restarting the app. The view calls the stage-owned recovery primitives (claims: CLAIMS-20 `retryClaimsItem`/`dismissClaimsItem`/`listSetAsideItems`) — no parallel reader/epoch logic in the view | test:app/src/kb/pipelineControl.test.ts, app/src/shell/views/statusView.test.ts, app/src/main/ipc.test.ts | ORCH-12; CLAIMS-20; [#137](https://github.com/masra91/KB-App/issues/137) |
| OBS-18 | must | **Crash capture (local-only).** Electron's built-in **`crashReporter`** is started with **no upload** (`uploadToServer: false`; minidumps kept in `<userData>/Crashpad`), **and** JS process-level handlers are installed — `process.on('uncaughtException'/'unhandledRejection')` (main + renderer) and main-process **`render-process-gone` / `child-process-gone` / `gpu-process-crashed`** — each writing a structured **`fatal`/`crash`** dev-log entry (reason + stack + the **last `runId`/`itemId`/`stage`**) to the app-level log **before exit**. *Today there is NONE — a native/worker trap captured nothing (no minidump, no breadcrumb).* A native trap may be uncatchable, but the minidump + last-known-state turn "captured nothing" into a symbolicable dump + a breadcrumb | test:app/src/kb/crashCapture.test.ts, app/src/kb/activityBreadcrumb.test.ts | OBS-2,4; PRIN-19; AUTO-8 |
| OBS-19 | must | **Fix the app-level dev-log sink (OBS-2 regression).** The `<userData>/logs/app.log` sink is **not created in a live install** (forensics 2026-06-07: the dir was absent), so pre-vault/main-process errors — and crash breadcrumbs (OBS-18) — vanish. The app-level `createAppDevLog` MUST create its sink **eagerly on boot** (not lazily on first write) and a **regression test** asserts the log file exists after app init | test:app/src/kb/devlog.test.ts | OBS-2 |
| OBS-20 | must | **Resource/memory telemetry.** A periodic, **low-overhead** sampler records `process.memoryUsage()` (rss/heapUsed/heapTotal/external/arrayBuffers) and `app.getAppMetrics()` (per-process CPU/mem) to the dev-log + perf-index, on a coarse interval (default ~60s, leveled), so memory over a long run is a readable **trend** — the prime suspect for the V8-worker trap — not a mystery. Local-only; redaction-irrelevant (numbers only) | test:app/src/kb/memorySampler.test.ts | OBS-1,14; PRIN-19 |
| OBS-21 | should | **Leak / long-run watchdog.** Detect **sustained monotonic RSS/heap growth** over a rolling window (no plateau across N samples) and emit a **loud `warn`** ("memory climbing: rss +X MB over Ym") so a slow leak is visible **before** an OOM-class trap; optional **heap-snapshot-on-threshold** (`v8.writeHeapSnapshot` into `<vault>/.kb/cache/`, gitignored, for offline diffing). Turns the silent climb-then-die into an early signal | test:app/src/kb/memorySampler.test.ts | OBS-11,20 |
| OBS-22 | should | **Status-view health panel.** The Status view surfaces a **memory/health** readout — current RSS/heap + the OBS-21 trend + the **last crash breadcrumb** (OBS-18: when/where/last item) — so "is memory climbing / did we recently crash + on what" is answerable at a glance | test:app/src/shell/views/statusView.test.ts | OBS-5,15,20 |
| OBS-23 | must | **Status/diagnostic reads are bounded (tail-read) — the read-only diagnostic must never self-stall.** The Status poll's reads MUST be **O(recent-window), not O(file-size)**: `readSpans` (and the audit/dev-log reads it drives) **tail-read only the recent window** (the last N lines/bytes it already trims to), **never whole-file-read-then-slice**, so a large or actively-growing `spans.jsonl`/audit can't make the status poll slow or blow the **8 s load-guard** (`loadGuard.ts`). Complements OBS-21 (rotation caps *size*); tail-reading caps **per-poll work + memory regardless of size**. (Git status calls already time-bounded — ORCH-24.) *The #256 cascade bloated `spans.jsonl`; today `readSpans` `fs.readFile`s the whole file every poll → the user-visible 8000ms status timeout.* | test:app/src/kb/perfIndex.test.ts | OBS-5,8,12,21; ORCH-24,26; [#256](https://github.com/masra91/KB-App/issues/256) |
| OBS-24 | must | **Status is read from a MAINTAINED SNAPSHOT — the UI never synchronously re-reasons across the working zone (timeout structurally impossible).** The current model (`pipelineStatusView` → `pipelineStatusForActive()` **recomputes on every poll** — file-walks + **git** worktree/lock enumeration on the render path, under the 8 s guard) is the antipattern: under load a git read **blocks behind the pipeline's own git ops** → intermittent timeout. **The MUST is the outcome:** the render path (Status view + QCAP-14 tray) does **zero git / fs / recompute** — it reads a **continuously-maintained in-memory snapshot** (per-stage state · queue depth · current item · lock held/free · job runs + the derived funnel/perf bits), **persisted** as last-known-good (shown instantly on launch) + stamped with an **"as of" timestamp** (a slightly-stale status is honest + fine; a timeout is not). The snapshot may be maintained by a **background-cadence compute** (the cache form) — **that satisfies the must / is the done-bar.** **SHOULD (stronger fast-follow):** workers + the harness **PUSH** their state as a side effect of doing the work (they already own it), so the snapshot is real-time + needs no background recompute of the live bits (cadence then only for the expensive derived bits). Either form: **no hard dependency on a live compute on the render path → a timeout is structurally impossible.** | test:app/src/main/statusSnapshot.test.ts | OBS-5,8,23; ORCH-10,16; QCAP-14; [#256](https://github.com/masra91/KB-App/issues/256) |
| OBS-26 | must | **A "current item" marker NEVER becomes a stale forever-growing ghost — it's cleared/expired when no live worker backs it, and a past-max-runtime dwell reads as "stalled?", not a silent growing number.** A stage's in-progress marker (`currentItem` + its `startedAt`) can outlive the work: the archivist's **persisted** `processing` field survives a mid-item kill, and a wedged drain can leave `busy` set — so the snapshot showed *"caroline linking for 4602s"* (~77 min) with **no copilot proc, zero unclosed spans, the real spans finished `ok` ~31 min prior**. The displayed duration `now − startedAt` grows forever and reads like a **catastrophic hang**. The MUST: (a) a `currentItem` is surfaced **only when the stage is actually `busy`** (a live worker backs it) — a persisted marker with no live drain is **not** shown as in-progress; (b) the dwell render **caps at a max plausible per-item runtime** and past it shows a bounded, questioning **"stalled?"** rather than an ever-growing seconds counter. *(Principal, 2026-06-08: a 77-minute ghost "current item" with nothing actually running.)* | test:app/src/kb/pipelineStatusView.test.ts (currentItem dropped when not busy), app/src/shell/views/theLineModel.test.ts (dwell past max → "stalled?") | OBS-5,24; ORCH-26; SPEC-0032 VIZ-2 |
| OBS-25 | must | **Cold-start shows "opening your KB…", never a long "no knowledge base open."** At launch, before the active KB finishes opening (`active` resolves — worktree ensure, config read, queue reads), the Status view (and QCAP-14 tray) shows the **empty "no knowledge base open" state**, which is **indistinguishable from genuinely having no KB** — so a normal (multi-second) open reads as *broken*. The surface MUST distinguish **three** states: (a) **no KB configured** → the real "no knowledge base open" empty state; (b) **opening / initializing** (a KB *is* configured and open is in progress) → a calm **"opening your KB…"** state; (c) **ready** → the maintained snapshot (OBS-24). The **persisted last-known-good snapshot** (OBS-24) SHOULD be shown **immediately on launch** (stamped "as of") so even during (b) the Principal sees prior state rather than a blank/empty surface. The cold-start window must be **visibly bounded** (a progress/initializing affordance), never a long silent empty state that looks like a failure. *(Principal, 2026-06-08: "status says no knowledge base open for a long time before it shows.")* | test:app/src/shell/views/statusView.test.ts, statusSnapshot.test.ts (configured-but-not-yet-open resolves to the **opening** state, not the no-KB empty state) — none-yet | OBS-24,5; QCAP-14; PRIN-5 |

## 6. User flows / surface

- Open **Pipeline Status** → see Archive `blocked — error`, queue depth 2, last activity 4m ago
  → click the error → dev-log: *"staging worktree provision failed: <git error>"*. Stuck cause
  found in seconds.
- A source set aside after 3 Decompose attempts → shown in the view with reason → drill into the
  Copilot stderr.

## 7. Out of scope (for now)

- ~~Interactive recovery~~ — **now in scope as OBS-17** (Principal requested after hitting poison-loops):
  retry / set-aside / dismiss a stuck item from the view. (Earlier deferred; promoted to a follow-up slice.)
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

- 2026-06-09 — **OBS-26: stale "current item" ghost — implemented** (KB-Developer-2). A *"caroline linking
  for 4602s"* (~77 min) ghost with no live worker: the archivist's **persisted** `processing` survived a
  mid-item kill, and the dwell `now − startedAt` grew forever, reading like a catastrophic hang. Fixed both
  halves: (a) `computePipelineStatus` surfaces archive's `processing` **only when `orch.busy()`** (no live
  drain ⇒ no current-item / no in-flight carriage), and `assemblePipelineStatus` drops any stage `currentItem`
  whose stage isn't `busy` (the general invariant: no backing worker ⇒ no marker); (b) `dwellLabel` caps at
  `MAX_PLAUSIBLE_DWELL_MS` (10 min) and past it renders **"stalled? · Nm"** instead of an ever-growing seconds
  counter. ENG-15/16: regression tests for the stale-marker drop + the past-max dwell. `Verify` graduated.
- 2026-06-08 — **OBS-25: cold-start "opening your KB…" vs a long "no knowledge base open" (Principal-reported).**
  OBS-24 fixed the freeze (status reads a maintained snapshot now), but at launch — before `active` resolves —
  the view shows the empty *no-KB* state, indistinguishable from genuinely having no KB, so a normal multi-second
  open reads as broken. OBS-25 requires three distinct states (no-KB-configured / opening / ready), shows the
  persisted last-known-good snapshot immediately, and makes the cold-start window a visibly-bounded "opening…"
  affordance. *(Principal: "status says no knowledge base open for a long time before it shows.")*
- 2026-06-08 — **OBS-18..22 IMPLEMENTED** (crash capture + memory/leak telemetry; the #256 enabler).
  Pure, injected, node-testable modules: `kb/crashCapture` (crashReporter no-upload + uncaught/rejection
  + render/child/gpu-process-gone handlers → `crash.*` app-log entry + sync-persisted `last-crash.json`;
  `uncaughtException` preserves crash-on-uncaught via bounded-flush→exit 1), `kb/activityBreadcrumb`
  (last `{stage,item,run}`, fed by a new `devlog` `onEmit` hook — zero stage-code change), `kb/memorySampler`
  (coarse 60s sampler + `detectLeak` monotonic-growth watchdog + once-per-episode heap snapshot, writer
  injected so `node:v8` never enters the renderer bundle). Wired in `main/telemetry` (electron-free glue;
  electron bits passed from `main.ts`). OBS-19 makes `createAppDevLog` eager. OBS-22 adds `health` to the
  status view-model + a faithful-mirror Status readout. Renderer-side (OBS-18 "main + renderer") forwards
  `window` error/rejection over `kb:reportRendererError`. **Two honest implementation notes:** (a) OBS-20
  "dev-log + perf-index" — the **durable record is the dev-log** (`mem.sample` lines); the **live trend** is
  an in-memory ring surfaced on the OBS-22 health readout (which sits alongside `perf` on the view-model).
  Memory is **deliberately NOT appended to the spans/perf-index file** — that would defeat the O(1) /
  low-overhead constraint (KB-Lead's careful-review flag) and pollute the span store. (b) OBS-21 heap
  snapshot fires **at most once per leak episode** above a high RSS-growth threshold (snapshots are
  hundreds of MB / multi-second), re-arming after a plateau. No new deps (Electron `crashReporter` + node
  `v8`/`process`/`fs`). Verify columns updated (SPECSYS-7). PR #265 → KB-QD gate-2.
- 2026-06-07 — **OBS-18..22: crash capture + memory/leak telemetry (the blind-spot a real crash
  exposed).** A packaged-app crash (`EXC_BREAKPOINT`/`SIGTRAP` on a V8 `ThreadPoolForegroundWorker`,
  ~2h uptime) was **undiagnosable** because the app captured nothing. Forensics (KB-Lead, from the macOS
  `.ips` + the live install): the report had **no Application-Specific-Information** (no V8 fatal reason),
  **`crashReporter` was off** (no minidump), there were **no crash handlers**, the **app-level dev-log was
  never created** (`<userData>/logs/` absent — an OBS-2 regression), and there is **no memory telemetry**.
  The *pipeline* dev-log DID help — it showed a `decompose.failed` cascade + recurring `lock.stuck` around
  the crash — which is why we **extend** the diagnostics subsystem rather than replace it. New §4a + five
  requirements, all **local-only** (no upload/egress, PRIN-19): **OBS-18** crash capture (built-in
  `crashReporter` no-upload + `uncaughtException`/`unhandledRejection`/`*-process-gone` handlers →
  structured breadcrumb with last runId/itemId), **OBS-19** fix the missing app-level log sink (+
  regression), **OBS-20** periodic `memoryUsage`/`getAppMetrics` sampling to dev-log/perf-index, **OBS-21**
  leak/long-run watchdog (monotonic-growth warn + heap-snapshot-on-threshold), **OBS-22** Status-view
  health panel (RSS/heap trend + last crash breadcrumb). Uses **no new deps** (Electron `crashReporter` +
  node `v8`/`process` built-ins, E1). **The crash itself is filed P1** (root cause still open — needs a
  symbolicated dev-build repro; this work is the enabler). Decision: crash/telemetry data stays **on-disk,
  no upload** — matches §7 "local on-disk only."
- 2026-06-02 — **SPEC-0032 §9 dep: in-flight item roster on the view-model (VIZ-2).** The
  `PipelineStatusView` gains `inFlight: InFlightItem[]` — every queued item as a "carriage" at its
  stage, `active` marking the draining batch. Pure `buildInFlightRoster` computes `active = busy &&
  index < cap` (the drain processes `queue[0..cap)`) — **no surgery on the load-bearing drain
  concurrency**; each drain stage just gained a tiny `currentSince()` timestamp for the active
  carriage's dwell (`sinceTs` precise-for-active, omitted-for-queued per DEV-4). Gathered in
  `pipeline.ts` (archive: `processing` + inbox, cap 1; connect cap 1; decompose/claims cap STAGE_CAP).
  Third + final §9 data field (after STAGE_ORDER #168 + conversion counts #169); the `kb:pipelineEvent`
  push is the remaining VIZ §9 piece. Tested: `buildInFlightRoster` (active batch + sinceTs, idle, name
  fallback, multi-stage) + the stage `currentSince` additions are covered by the existing stage suites.
- 2026-06-02 — **#163: surface a STUCK write lock (OBS-7/11).** DEV-2's watchdog (#170) added
  `LockState.stuck`/`heldMs`; this renders them so the silent canonical-writer deadlock the watchdog
  catches is now **visible**: `lockHtml` shows "⚠️ Stuck — held by `<holder>` for `Ns`; the pipeline
  is wedged" (and the held-duration on a normal hold); `overallHtml` adds a specific stuck banner; and
  the assembler treats a stuck lock as **`overall: 'stalled'`** — without that, `lock.held` reads
  `running` and masks the wedge (the exact silent-stall this spec exists to make loud). Holder labels
  are `stage:op` (#170), shown via `holderLabel` as "Claim extraction (advance)" — naming the exact
  stuck section. View-only (my half of the #163 lock split; DEV-2 owns the lock mechanics). Tests:
  assembler stuck→stalled; lockHtml stuck + held-duration; overallHtml stuck banner.
- 2026-06-02 — **#163 fix: stage error badges are now time-bounded (OBS-5/6).** `hasErrorFor` flagged
  a stage errored if *any* of the last-N warn/error log lines was an error — no time bound and (since
  the dev log only surfaces warn+error here) no info-level "progress" to supersede it — so a recovered
  stage stayed **red forever**. New pure `deriveStageError(errors, stage, nowMs, freshMs)`
  (`DEFAULT_ERROR_FRESH_MS` = 2 min) marks a stage errored only on a **fresh** error: a one-off error
  ages out (then `deriveStageState` shows running/idle), while a genuinely-broken stage re-errors each
  attempt and stays red. Regression test (fails-before/passes-after): a stale error → not-errored
  (the old unbounded check returned errored). `pipeline.ts` calls it with `Date.now()`.
- 2026-06-02 — **OBS-17 extended to Connect (the stage-agnostic seam, additive — no rewrite).** The
  recovery surface now covers **connect** set-aside (poison) blocks alongside claims, exactly as the
  seam was designed. Refactored the pure layer to be stage-agnostic: `planSetAsideAction(targets, req)`
  takes a pre-resolved `{id, handle, label}[]` (the `handle` is **server-derived** — entityRel for
  claims, blockKey for connect — never the renderer's `itemId`, the #153/#157 trust boundary) and
  `toSetAsideViews(items, stage)` tags any stage; `pipeline.ts` dispatches per stage (claims →
  `listSetAsideItems`/`retryClaimsItem`/`dismissClaimsItem`; connect → DEV-1's #157
  `listConnectSetAsideItems`/`retryConnectItem`/`dismissConnectItem`) and the assembler unions both
  stages' views. Adding decompose later is one more dispatch branch + a list mapper — the planner,
  view, and IPC contract are unchanged. Tests: stage-agnostic `planSetAsideAction` (claims + connect
  targets + trust-boundary no-op), `toSetAsideViews(items, stage)`, mixed-stage panel render. DEV-1
  verifies the connect e2e (poison block → Status view → Retry/Dismiss).
- 2026-06-02 — **OBS-17 action-half → test:. Interactive unblock complete.** The Status view's
  set-aside panel now carries **Retry** + **Dismiss** per item, wired to a new **`kb:pipelineControl`**
  IPC (`{action, stage, itemId}`, stage-parameterized) → `pipelineControlForActive` (main/pipeline.ts).
  The mutation logic is the **stage-owned primitive** (claims: DEV-2's `retryClaimsItem` /
  `dismissClaimsItem`, CLAIMS-20 #146) run under the shared canonical-writer lock; **retry pokes the
  Claims drain** so the item re-derives promptly. The branchy decision (validate stage+action, resolve
  the surfaced `itemId` → entity node path against the live `listSetAsideItems`, or report a no-op for
  an already-recovered/unsupported item) is a **pure `planSetAsideAction`** (`app/src/kb/pipelineControl.ts`)
  so it's unit-testable without electron; pipeline.ts is thin glue. Renderer: single-flight buttons
  (disabled while acting), **dismiss is confirmed first** (it retires the item), an outcome banner, and
  a re-fetch after each action. **OBS-9 reconciled** — the view is read-only *except* this sanctioned
  OBS-17 recovery affordance (carve-out added to OBS-9). **Scope:** claims-only v1; the `stage` on the
  request/buttons + the stage guard in the planner are the seam where decompose/connect become additive.
  Tested: `pipelineControl.test` (planner: resolve retry/dismiss, name/id label, non-claims + unknown
  action + already-recovered no-ops, empty list), `statusView.test` (Retry fires `{retry}` + re-fetches
  + banner; Dismiss confirms then fires `{dismiss}`, cancel = no-op; buttons carry stage/id; disabled +
  banner while acting; the read-only set now = drilldown + the two sanctioned actions), `ipc.test`
  (`kb:pipelineControl` forwards the request + returns the result). With this, **every OBS requirement
  including OBS-17 is `test:` — SPEC-0030 is fully closed end-to-end.**
- 2026-06-02 — **OBS-17 read-side (set-aside recovery surface).** The first, independent half of
  the interactive-unblock requirement: surface the **claims poison items** (entities whose current
  claims state is terminal via `setaside` — not `claimed`/`dismissed`) so the Principal can see WHAT
  the pipeline gave up on + WHY. Reads through the **canonical claims-path reader**
  `claimsStage.listSetAsideItems(root)` (CLAIMS-20, owned by the set-aside path owner — no parallel
  reader to drift; it honors retries/dismisses/replay-epochs via `readClaimsState`). A small pure
  view-mapper `toSetAsideViews` (in `pipelineStatusView.ts`) maps the domain items to the Status-view
  presentation shape `SetAsideView { stage, itemId, name?, reason? }` — tagging `stage:'claims'` and
  deriving the reason from the failure/round counts (`setAsideReason`: K failed attempts ORCH-12, or
  the review-cascade cap REVIEW-8). Feeds a new `setAsideItems: SetAsideView[]` on the
  `PipelineStatusView` (gathered in `main/pipeline.ts`), rendered as a **"Set aside — needs attention
  (N)"** panel in `statusView.ts` (`setAsideHtml` — `stage · name` (friendly, falls back to the id) +
  reason, XSS-escaped, display-only). **Scope (PM ruling):** claims-only for v1 (claims is where the
  #135 poison-loop wedged us), but the view carries its `stage` so decompose/connect are additive.
  Tested: `pipelineStatusView.test` (`setAsideReason` failure/round/fallback branches; `toSetAsideViews`
  mapping; assembler passthrough), `statusView.test` (panel renders name-over-id + reason, id fallback,
  empty → no panel, XSS-safe, present in `bodyHtml`). **Deferred — the action half (OBS-17 not yet
  fully `test:`):** the `kb:pipelineControl` IPC (`{action, stage, itemId}`, stage-parameterized) +
  retry/dismiss buttons, coupling to DEV-2's now-merged claims primitives
  (`retryClaimsItem`/`dismissClaimsItem`, #146). The error-message + offending-item drill-down already
  shipped with the Status view (OBS-6 `errorsHtml`); this adds the dedicated poison-recovery list.
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
