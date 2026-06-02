---
spec: SPEC-0027
key: PANEL
title: Control Panel (manage agents, sources & jobs)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-01
updated: 2026-06-01
related: [SPEC-0003, SPEC-0006, SPEC-0009, SPEC-0014, SPEC-0017, SPEC-0018, SPEC-0023]
stage: Cross-cutting
supersedes: null
---

# Control Panel (manage agents, sources & jobs)

> The **"manage" surface** (VISION-11): a **Manage section** in the nav shell carrying sibling
> views — **Jobs · Agents · Sources · Settings** — to **observe and configure** the machine.
> Each is a registered shell view (SPEC-0017); the section grows as features land. v1 makes
> **Jobs** fully manageable (SPEC-0023), **elevates Settings**, lists **Agents**, and stubs
> **Sources**.

## 1. Intent (the why / JTBD)

The app is mostly headless — it surfaces for **capture** and **recall**, and otherwise runs
agents/jobs in the background. The **Control Panel** is the occasional window to **manage
librarian agents, connect data sources, set recurring tasks, and configure settings**
(SPEC-0003 §4, VISION-11). As autonomous jobs (SPEC-0023) and more stages arrive, their config
needs a **home** — today it's nowhere (Settings is display-only, SHELL-3).

JTBD: *"when I do open the app to tune it, give me one clear place to see what the agents/jobs
are doing and change how they run — without editing files by hand."*

## 2. Structure — a "Manage" section in the shell

Built on **SPEC-0017's view registry** (register `id/label/mount`). The Control Panel is **not
one monolithic view** — it is a **group of sibling nav-rail views** under a **"Manage"**
heading:

```
[ Capture ]   ← default, sacred (SHELL-4)
[ Reviews ]   ← the "needs you" queue (SPEC-0018), its own view
── Manage ──
[ Jobs ]  [ Agents ]  [ Sources ]  [ Settings ]
```

Exactly one view active at a time (SHELL-2). Reviews stays its own top-level view; the panel
**links to it** (the "needs you" count).

## 3. The v1 views

- **Jobs (recurring tasks) — fully manageable.** Lists the SPEC-0023 autonomous jobs. Per job:
  **enable/disable**, **schedule preset** (a few/day · hourly · daily · off), **autonomy
  posture** (Guarded/Autonomous), **run-now**, and **last-run** state from the job journal
  (what it looked at / found / deferred). The strongest, fully-backed v1 view.
- **Agents (librarians) — observe + light config.** Lists the stage/librarian agents
  (archivist, decompose, connect, claims, reflect, ask…) with status + key config (model,
  instruction-file pointer). v1 = observe + safe knobs; full agent authoring is later.
- **Sources / Connections — stub + watched folders.** Shows the vault + any watched folders,
  with **placeholder** slots for future connected sources (email/calendar/news — Proactive
  Intake). Thin in v1 (most integrations unbuilt), but the view exists and grows.
- **Settings — elevated.** Elevates SPEC-0017's display-only Settings (active KB, Copilot
  status) to also hold **autonomy defaults** (per-Instance posture, AUTO-12), vault config, and
  the first-run **setup-editing** seam (SETUP-8).

## 4. Requirements

| ID      | Priority | Statement (short)                                                                  | Verify   | Traces |
| ------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| PANEL-1 | must     | The Control Panel is a **"Manage" section of sibling views** registered in the nav shell — **Jobs, Agents, Sources, Settings** — to observe+configure the machine; one active at a time; Capture stays default | none-yet | VISION-11; SHELL-2,4 |
| PANEL-2 | must     | The **Jobs** view lists autonomous jobs (SPEC-0023) and lets the Principal **enable/disable**, set **schedule preset**, set **autonomy posture** (Guarded/Autonomous), **run-now**, and see **last-run** state from the job journal | none-yet | JOBS-1,2,11,14,15; AUTO-12 |
| PANEL-3 | must     | The **Agents** view lists librarian/stage agents with **status + key config** (model, instruction file); v1 is observe + safe knobs (full agent authoring deferred) | none-yet | VISION-11; ORCH-9 |
| PANEL-4 | should   | The **Sources** view shows the vault + watched folders and **placeholder** slots for future connected sources (Proactive Intake); thin in v1, grows as integrations land | none-yet | VISION-11 |
| PANEL-5 | must     | The **Settings** view (elevating the display-only stub) holds vault config, **Copilot status**, and editable **autonomy defaults** (per-Instance posture) | none-yet | SETUP-8; AUTO-12 |
| PANEL-6 | must     | Config changes are **persisted** (per-Instance config — where jobs/posture/agent settings live) and take effect **without a restart** where feasible | none-yet | SETUP-6; SCOPE-1 |
| PANEL-7 | must     | **Risky/destructive** panel actions (disable a stage, set posture → Autonomous, retire an agent) **confirm** and are **audited**; read-only observation needs no confirm | none-yet | AUTO-1,8 |
| PANEL-8 | should   | The panel **links to the Review queue** (SPEC-0018) — the "needs you" count is visible from Manage | none-yet | REVIEW-?; AUTO-10 |
| PANEL-9 | should   | Panel views **reflect live status** (ORCH-10) and **degrade gracefully** when a backing feature isn't built yet (e.g. Sources stub) | none-yet | ORCH-10 |

## 5. User flows / surface

- Open app → nav rail shows **Capture** (default) + a **Manage** group (Jobs/Agents/Sources/Settings).
- **Jobs:** toggle Reflect on → set "a few times/day" → posture **Guarded** → **Run now** → see last-run.
- **Settings:** set the autonomy default; see active KB + Copilot status.
- **Agents:** see archivist/decompose/connect/claims running + their models.

## 6. Out of scope (v1)

- **Full agent authoring** — creating new librarian agents from scratch / editing instruction
  files in-app. v1 is observe + safe knobs.
- **Real connected-source integrations** (email/calendar/news OAuth) — those are **Proactive
  Intake**; v1 Sources is a stub + watched folders.
- **Activity / Audit feed** (AUTO-9) — its own feature (**AUDIT**); the panel may link to it later.
- **Internal sub-tab model** — v1 uses **sibling nav items**, not a tabbed mega-view.

## 7. Open questions

- [ ] **Per-Instance config home** — the config file/schema the panel reads/writes (ties to
      SETUP-6 `appConfig` + the JOBS registry).
- [ ] **Agent config depth** — how much is safe to expose v1 (model? instruction file? per-agent
      posture?).
- [ ] **"Manage" grouping** — a visual heading in the flat rail vs. a collapsible group (the
      shell rail is flat today; may need a small SHELL extension).
- [ ] **Live-status update** — poll ORCH-10 vs. a push channel.
- [ ] **Confirm vs. Review** — do posture/schedule changes need a Review item, or just
      confirm + audit? (PANEL-7 leans confirm for risky.)

## 8. Changelog

- 2026-06-01 — created (draft). The VISION-11 "manage" surface as a **Manage section of sibling
  views** in the nav shell (SPEC-0017): **Jobs** (fully manageable — SPEC-0023 schedule presets /
  posture / run-now / journal), **Agents** (observe + safe config), **Sources** (stub + watched
  folders, grows with Proactive Intake), **Settings** (elevated: vault / Copilot / autonomy
  defaults). **Observe + configure**; config persisted per-Instance; risky changes confirm +
  audit. Forks resolved with the Principal: **management-core view set**, **sibling nav items
  (not a tabbed monolith)**, **observe + configure depth**.
