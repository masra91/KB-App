---
spec: SPEC-0045
key: QUIESCE
title: Graceful Shutdown (Quiesce & Drain)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-08
updated: 2026-06-08
related: [SPEC-0014, SPEC-0023, SPEC-0027, SPEC-0030, SPEC-0037, SPEC-0038, SPEC-0041]
stage: Cross-cutting
supersedes: null
---

# Graceful Shutdown (Quiesce & Drain)

> A **"Prepare for shutdown"** affordance that **stops starting new work, lets in-flight work
> finish cleanly, and tells you when it's safe to quit.** It is a *convenience* — the system stays
> **unconditionally fault-tolerant** to an *unexpected* stop (sleep, network outage, crash,
> force-quit); graceful quiesce is just the **preferred** path so the user isn't quitting mid-flight.
> A modest control (Settings + tray), not a major button. (Principal, 2026-06-08.)

## 1. Intent (the why)

The app runs autonomous background work (ingestion, the Enrich pipeline, scheduled jobs/researchers).
A user who wants to close the laptop or restart has no clean way to say *"wind down — finish what
you're doing, start nothing new, and tell me when you're idle."* Today they either quit mid-item
(relying on fault-tolerance) or guess. **Quiesce** makes the **preferred** shutdown a deliberate,
observable drain — while **never** weakening the guarantee that an *abrupt* stop is also safe.

## 2. The model — drain, don't kill

```
[Prepare for shutdown]  (Settings / tray)
        │
        ▼
  QUIESCING: stop starting NEW work ──────────────────────────────┐
    · pause new ingestion (WATCH/INTAKE/quick-capture-enqueue)     │  in-flight work
    · stop picking up new pipeline items                           │  KEEPS RUNNING to a
    · pause scheduled jobs/researchers from new runs               │  clean commit (no
        │                                                          │  half-applied state)
        ▼                                                          │
  DRAINING: in-flight stage agents/jobs finish their current item ◄┘
        │   live progress: "N tasks remaining…"
        ▼
  IDLE: queue empty · no agent in flight · writer lock free
        │
        ▼
  ✅ "Safe to shut down"   (and optionally: auto-quit, if the user asked)
```

Reversible: **Resume** un-pauses before the user actually quits, if they change their mind.

## 3. Fault-tolerance is the floor (quiesce is above it, never instead of it)

This spec **adds no new correctness requirement** — it leans on guarantees that must already hold:
- **Idempotent / restartable** pipeline (ORCH-13) — restart resumes from durable queue/marker state.
- **Restart-safe reconcile** (WATCH-5/8; INTAKE dedup) — arrivals during downtime aren't lost or doubled.
- **Crash-safe canonical writer** (ORCH-25/26/27 — bounded git, cascade bound, stale-lock self-heal).

⇒ **An abrupt stop is always safe** (machine sleep, Wi-Fi drop, OOM, force-quit, power loss). Quiesce is
the *graceful* path on top of that floor — it makes "I'm about to quit" tidy, it is **not** what makes
quitting safe. If quiesce itself is interrupted (the user force-quits mid-drain), the next start simply
reconciles + resumes — same as any other abrupt stop.

## 4. Requirements

| ID | Priority | Statement (short) | Verify | Traces |
| -- | -------- | ----------------- | ------ | ------ |
| QUIESCE-1 | must | A **"Prepare for shutdown"** action (in **Settings**, SPEC-0027; **and** optionally the **tray menu**, SPEC-0038) puts the system into **QUIESCING**: **stop starting new work** — pause new **ingestion** (WATCH/INTAKE/quick-capture enqueue), stop picking up **new pipeline items**, pause **scheduled jobs/researchers** from starting new runs | test: `quiesceBoundary` (4 producers stopped) + `settingsView` + capture-pause gate (`isActiveQuiescing`) | PANEL-1; ORCH-1; JOBS; WATCH; INTAKE |
| QUIESCE-2 | must | Quiesce is a **drain, not a kill** — **in-flight** stage agents/jobs **finish their current item and commit cleanly** (no half-applied state; the canonical writer completes its current section); not-yet-started items stay **durably queued** for the next start | test: `quiesceBoundary` (drainers kept running; `remaining` reflects queued); clean-commit = ORCH-12/13 (the QUIESCE-4 floor) | ORCH-12,13,18; CANON-1 |
| QUIESCE-3 | must | The user sees **live drain progress** — *"N tasks remaining"* across stages + jobs — and a clear, trustworthy **"Safe to shut down"** signal when **queue empty + no agent in flight + writer lock free** (the same OBS status the Status view reads) | test: `quiesceBoundary` + `settingsView` (live N-remaining + safe-when-idle: queues empty + nothing in flight + lock free) | OBS-5,9; VISION-11 |
| QUIESCE-4 | must | **Fault-tolerance is unconditional and independent of quiesce:** an **unexpected** stop (sleep, network outage, app/OS crash, force-quit, power loss) is **always safe** — on restart the pipeline **reconciles + resumes** from durable state with **no lost or double-applied work**. Quiesce is the *preferred* path, **never** a correctness prerequisite; interrupting a quiesce is just another abrupt stop | test: existing fault-tolerance suite (ORCH-13/25/26/27, WATCH-5/8) — quiesce adds **no new correctness code**; `quiesceBoundary` confirms the drainers are untouched | ORCH-13,25,26,27; WATCH-5,8; PRIN-1 |
| QUIESCE-5 | should | Quiesce is **reversible** — a **Resume** un-pauses new work before the user quits, if they change their mind; state returns to normal running | test: `quiesceBoundary` + `settingsView` (Resume restarts producers → normal) | AUTO-12 |
| QUIESCE-6 | should | A **modest, non-major affordance** — lives in Settings (+ optional tray item), **not** a prominent/destructive-styled button; it surfaces the drain status inline and (optionally) offers **"quit when safe"** so the user can walk away and the app quits itself once idle | test: `settingsView` (modest non-danger control + inline drain readout) + `quiesceTray`/`trayMenu` (the optional tray toggle) | PANEL-1; QCAP-3 |

## 5. User flows

- **Closing the laptop:** Settings → *Prepare for shutdown* → watch *"42 tasks remaining…"* tick down →
  *"✅ Safe to shut down"* → quit. (Or tick *"quit when safe"* and walk away.)
- **Changed my mind:** *Prepare for shutdown* → *Resume* → back to normal.
- **Forgot and force-quit mid-drain:** next launch reconciles + resumes — no harm (QUIESCE-4).

## 6. Out of scope

- **Forcibly killing** in-flight work to quit faster — quiesce always *drains*; an impatient user just
  uses the OS quit (safe by QUIESCE-4), no special "hard stop" needed.
- **Scheduling shutdowns** / power management — this is a manual, on-demand affordance.

## 7. Open questions

- [ ] **"Quit when safe" auto-quit** — does the app actually terminate itself when idle (QUIESCE-6), or
      only signal "safe"? (Lean: offer both — signal by default, auto-quit opt-in.)
- [ ] **Long-running in-flight item** — a single 60s+ Copilot call mid-drain: just wait (drain), or also
      offer "stop after this batch"? (Lean: just wait; the per-item is already bounded.)
- [ ] **Tray vs Settings primacy** — both per QUIESCE-1/6; which is the primary surface.

## 8. Changelog

- 2026-06-08 — **QUIESCE-6 tray fast-follow** (KB-Developer-2). The optional tray affordance: a single
  "Prepare for shutdown…" / "Resume — cancel shutdown" item via DEV-7's `getExtraTrayItems` hook on the
  section-composed `setTray` (QCAP-14, #296). Runs in the main process so it calls the controller directly;
  toggles on the synchronous `isActiveQuiescing()` (the tray re-evaluates on menu-open). The live drain
  count is the QCAP-14 status readout already at the top of the tray; this is the action toggle. Pure
  `quiesceTray` helper (electron-free, node-tested) + the existing `trayMenu` splice test.
- 2026-06-08 — **Implemented (Settings affordance + drain controller)** (KB-Developer-2). A quiesce flag on
  the active pipeline: `quiesceActive()` stops the 4 new-work producers (jobs/researchers/intake/watch
  schedulers) + the capture path pauses ingestion (QUIESCE-1), while the **drainers** (orchestrator +
  decompose/connect/claims) keep running so already-captured work finishes + commits via the existing
  ORCH-12/13 guarantees (QUIESCE-2). `quiesceStatusForActive()` composes "**N remaining**" + a "**Safe to
  shut down**" signal from the real queues + each stage/scheduler's new `busy()` + the writer-lock state
  (QUIESCE-3). `resumeActive()` restarts the producers (QUIESCE-5). A modest, non-danger **Settings →
  Shutdown** control with a live drain readout (QUIESCE-6). **Zero new correctness code** — quiesce leans
  entirely on the fault-tolerance floor (QUIESCE-4: existing ORCH-13/25/26/27 + WATCH-5/8); the boundary
  test confirms the drainers are untouched. `Verify` graduated for all six. The **optional tray** item
  (QUIESCE-1/6) is a fast-follow, coordinated with the QCAP-14 tray-status seam (DEV-7/DEV-1).
- 2026-06-08 — created (draft) per the Principal: a **"Prepare for shutdown"** that drains in-flight work
  + pauses new work + signals **"safe to shut down"**, in Settings (+ optional tray), a *modest* control.
  Framed as a **convenience on top of unconditional fault-tolerance** (QUIESCE-4) — it leans on the
  existing idempotent/restartable + restart-reconcile + crash-safe-writer guarantees (ORCH-13/25/26/27,
  WATCH-5/8); an abrupt stop stays safe regardless. Spec-first; impl + tests hand off to PM.
