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
[ Activity ]  ← read-only audit/lineage views (SPEC-0029), its own view
[ Pipeline ]  ← live status + diagnostics (SPEC-0030), its own view
── Manage ──
[ Jobs ]  [ Agents ]  [ Researchers ]  [ Sources ]  [ Settings ]
```

> **Researchers** (SPEC-0028) is a sibling Manage view: add-from-template (Web/Code/M365/custom),
> configure prompt/scope/egress/budget/MCP, enable, **run-now**, see findings/citations/escalations.

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
| PANEL-1 | must     | The Control Panel is a **"Manage" section of sibling views** registered in the nav shell — **Jobs, Agents, Sources, Settings** — to observe+configure the machine; one active at a time; Capture stays default | test:app/src/shell/navModel.test.ts | VISION-11; SHELL-2,4 |
| PANEL-2 | must     | The **Jobs** view lists autonomous jobs (SPEC-0023) and lets the Principal **enable/disable**, set **schedule preset**, set **autonomy posture** (Guarded/Autonomous), **run-now**, and see **last-run** state from the job journal | test:app/src/kb/jobsPanel.test.ts, app/src/shell/views/jobsView.test.ts | JOBS-1,2,11,14,15; AUTO-12 |
| PANEL-3 | must     | The **Agents** view lists librarian/stage agents with **status + key config** (model, instruction file); v1 is observe + safe knobs (full agent authoring deferred) | test:app/src/kb/agentCatalog.test.ts, app/src/shell/views/agentsView.test.ts | VISION-11; ORCH-9 |
| PANEL-4 | should   | The **Sources** view shows the vault + watched folders and **placeholder** slots for future connected sources (Proactive Intake); thin in v1, grows as integrations land | none-yet | VISION-11 |
| PANEL-5 | must     | The **Settings** view (elevating the display-only stub) holds vault config, **Copilot status**, and editable **autonomy defaults** (per-Instance posture) | test:app/src/kb/instanceConfig.test.ts, app/src/shell/views/settingsView.test.ts | SETUP-8; AUTO-12 |
| PANEL-6 | must     | Config changes are **persisted** (per-Instance config — where jobs/posture/agent settings live) and take effect **without a restart** where feasible | test:app/src/kb/instanceConfig.test.ts, jobRegistry.test.ts | SETUP-6; SCOPE-1 |
| PANEL-7 | must     | **Risky/destructive** panel actions (disable a stage, set posture → Autonomous, retire an agent) **confirm** and are **audited**; read-only observation needs no confirm | test:app/src/kb/jobsPanel.test.ts (confirm gate + conforming `panel` audit events), app/src/shell/views/jobsView.test.ts + settingsView.test.ts (confirm UI) | AUTO-1,8 |
| PANEL-8 | should   | The panel **links to the Review queue** (SPEC-0018) — the "needs you" count is visible from Manage | test:app/src/shell/reviewBadge.test.ts, app/src/shell/shell.test.ts | REVIEW-?; AUTO-10 |
| PANEL-9 | should   | Panel views **reflect live status** (ORCH-10) and **degrade gracefully** when a backing feature isn't built yet (e.g. Sources stub) or its IPC fails/**hangs** (never an infinite spinner — #145) | test:app/src/kb/agentCatalog.test.ts (live status); app/src/shell/loadGuard.test.ts + per-view hang→retry/fallback tests (reviewsView/settingsView/activityView/sourcesView/jobsView/statusView) (degrade) | ORCH-10 |
| PANEL-10| should   | Action buttons (e.g. **Run now**) reflect a clear **state machine** — idle → confirm → **running** (disabled + status text) → back to idle on completion — never leaving the user unsure whether something is running | test:app/src/shell/views/researchersView.test.ts, app/src/shell/views/jobsView.test.ts | OBS-5; [#108](https://github.com/masra91/KB-App/issues/108) |
| PANEL-11| must     | **Lifecycle parity for user-created entities.** Every Principal-created managed entity (researchers, intake connectors/feeds, watched folders, …) supports the **full lifecycle**: create → configure (**every non-safety field editable**) → run/use → observe/debug → **delete**. **Delete is required, not optional** — a misconfigured entity can be **removed**, not merely disabled-forever: its config is **purged**, schedules torn down, and the removal **audited**, while **already-produced sources/findings + audit are RETAINED** (ground truth sacred). *Today delete is wired only for watched folders; researchers + intake feeds have NO delete at any layer — a systemic gap (disable-forever ≠ deletion).* | none-yet | DATA-2; AUDIT-11; RESEARCH-23; INTAKE-16 |

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
- 2026-06-02 — **slice 1 implemented** in `app/`. Added the **"Manage" section** to the nav shell
  (SPEC-0017): an optional `group?` on `NavView` renders a rail heading; registered **Jobs,
  Agents, Researchers, Sources, Settings** (Settings moved under Manage). The **Jobs view is fully
  manageable** (PANEL-2) over the live SPEC-0023 registry — list / enable-disable / schedule preset
  / autonomy posture / **run-now** / **last-run** from the job journal — with a known-job **catalog**
  (Reflect + the `example` reference job) merged with the per-vault registry so a known job is
  manageable before it's persisted (first edit persists via `upsertJob`). Risky changes (enable,
  → Autonomous, run-now) **confirm** before applying (PANEL-7); each config change emits a
  **conforming `panel` audit event** (field/from/to + the why) via SPEC-0029's `appendAuditEvent`
  (which enforces actor registration at emit — AUDIT-2/11), with the `staging` git commit retained
  as the durability record; changes take effect **without a restart** (the scheduler re-reads the
  registry each tick — PANEL-6). Untrusted IPC input is validated at the main-side boundary
  (`isSchedulePreset`/`isAutonomyPosture`; unknown job types refused). Graduated **PANEL-1/2/7**
  `Verify: none-yet → test:` (node-tier `jobsPanel.test.ts` for the merge + risk logic; happy-dom
  `jobsView.test.ts` for the view; `navModel.test.ts` for the Manage rail order; `jobs.e2e.ts`
  packaged-app smoke, CI-only). **Deferred to slice 2:** Agents observe content (PANEL-3),
  Sources vault+placeholders (PANEL-4), Settings elevation + per-Instance autonomy default via
  `.kb/instance.json` (PANEL-5), Review-queue link (PANEL-8), live-status polling (PANEL-9) — these
  ship as thin stubs in slice 1. **Researchers** view is a stub pending SPEC-0028.
- 2026-06-02 — **slice 2 implemented** in `app/`. Filled the Manage views' content: **Agents**
  (PANEL-3) — observe-only list of the librarian/stage agents (archivist/decompose/connect/claims/
  recall/reflect) with role, model (env-requested or Copilot default), instruction pointer, and live
  running/idle status; **Sources** (PANEL-4) — the vault + placeholder connected-source slots;
  **Settings autonomy** (PANEL-5) — an editable **per-Instance autonomy default** stored at
  per-vault **`.kb/instance.json`** (git-committed on `staging` for durability; conforming `panel`
  audit on change), with → Autonomous gated behind a confirm (PANEL-7). New jobs inherit the
  Instance default via a thin **`resolveJobPosture`** seam (AUTO-12 cascade: explicit per-job posture
  wins, else inherit — the single swap point if the Principal's ruling lands differently). **PANEL-9**
  live status (Agents poll, updated in place) + graceful degrade. Graduated **PANEL-3/5/6/9**
  `Verify: none-yet → test:` (node `instanceConfig` + `agentCatalog`; happy-dom `agentsView` +
  `settingsView`). **Deferred:** **PANEL-8** Review-queue link — needs an additive shell
  `navigate(viewId)` hook, sequenced **after DEV-5's Activity PR** to avoid a `shell.ts` collision.
  **Researchers** view remains a stub pending SPEC-0028.
- 2026-06-02 — **PANEL-8 implemented** (slice-2 tail, after DEV-5's Activity #70 settled the shell).
  The **Reviews rail item now carries a live "needs you" count badge** (`reviewBadgeText`/`reviewBadgeAria`,
  capped 99+), so the open-review count is visible from anywhere — including the Manage section — and
  the Reviews item is the link to the queue (clicking it navigates; no separate hook needed since the
  rail already navigates). Light poll keeps it live, degrades to no badge on no-KB/IPC-failure.
  Graduated **PANEL-8** `Verify: none-yet → test:` (node `reviewBadge.test.ts`; happy-dom
  `shell.test.ts`). **SPEC-0027 slices 1+2 complete** — only the **Researchers** Manage view remains
  a stub, pending SPEC-0028.
- 2026-06-02 — **#108 UI polish pass (KB-Lead's batch).** One styling pass across the Manage +
  Activity surfaces: (1) **dropdowns** — a single dark, theme-native `<select>` look with a custom
  caret (the UA default rendered light); (2) **short option labels** — researcher templates → `Public
  Web` / `Local Repository` / `WorkIQ-M365` / `Custom`, egress tiers de-parenthesized (`Local only`
  etc.), with the full gloss moved to a hover `title` (new `EGRESS_TIER_HINTS`) so the option text
  stays short; (3) **Run-now state machine (PANEL-10)** — the button itself now goes disabled +
  "Running…" while a pass is in flight and resets to "Run now" on completion/failure, in **both** the
  Researchers and Jobs views (graduated PANEL-10 `none-yet → test:`); (4) **Researchers card** — head
  + controls `flex-wrap` with gaps so rows no longer clip/cramp; (5) **Activity feed** — entry rows
  were default UA `<button>`s (light boxes) and raw events light `<pre>`s; both are now dark/
  theme-native (`var(--card)`/`var(--bg)`, hover + focus-visible states). Tests:
  `researchersView.test.ts` + `jobsView.test.ts` cover the run-now state machine + the short option
  labels/titles. The pure visual tuning (spacing/caret/contrast) is best confirmed by KB-Lead on a
  running build.
- 2026-06-02 — **#145: Manage views never infinite-spin (hardens PANEL-9).** PANEL-9 covered "IPC
  *fails* → friendly message", but a *hung* load IPC (e.g. `kb:listJobs` reading degraded staging and
  never returning) left the view on a perpetual "Loading…" — a `catch` can't help a promise that never
  settles. Added a shared `shell/loadGuard.ts`: `withTimeout(ipcCall, ms=8000)` bounds the wait (a hang
  rejects with a `TimeoutError` the existing `catch` handles), and `renderLoadError(container, header,
  onRetry)` shows a **retryable** fallback instead of a spinner. Wired into **Jobs / Researchers /
  Agents** (load via `withTimeout` → `renderLoadError` with a Retry button on timeout/failure) and
  **Status** (load via `withTimeout`; its existing live poll auto-retries, so no button — stays
  read-only per OBS-9). UI-only — ships independent of the backend `kb:listJobs` fix (#135 cascade).
  Tests: `loadGuard.test.ts` (timeout/passthrough/retry-render) + per-view hang→retry coverage.
- 2026-06-02 — **#145 follow-up: the resilience sweep is now complete across ALL Manage views (PANEL-9
  fully discharged).** #149 hardened Jobs/Researchers/Agents/Status; this extends the same
  `loadGuard` pattern to the remaining mount-loading views so none can infinite-spin on a hung IPC:
  **Reviews** + **Settings** (load via `withTimeout` → `renderLoadError` with Retry on timeout/failure),
  **Activity** (read-only AUDIT-8 — `withTimeout` on `activityFeed`/`activityLineage` → an inline
  retryable error in its body, header/controls stay mounted), and **Sources** (`withTimeout` on
  `getState`; its content is mostly static placeholders, so a hang degrades to the rendered view with
  em-dash vault info — graceful, never a spinner). Capture (a non-blocking status line) + Ask
  (on-demand recall, not a mount-gated load) are out of scope by design. Tests: per-view fake-timer
  hang→retry/fallback coverage (`reviewsView`/`settingsView`/`activityView`/new `sourcesView` tests).
- 2026-06-02 — **UI clarity / de-jargon pass** (KB-PM-triaged dogfood of the Manage surface + Recall +
  set-aside). Removed internal artifacts / dev jargon from user-facing copy, **display-layer only**
  (never mutating the canonical `kind`/`stage`/path/`id` the vault/audit/wikilinks depend on — guarded
  by unchanged-value tests). Two shared render helpers: `shell/formatTime.ts` (`formatTimestamp` →
  friendly/relative "2 min ago" / short date, replacing raw ISO everywhere it showed — Status, Activity,
  Researchers last-run) and `shell/stageLabels.ts` (`stageDisplayName` → readable stage/actor names:
  claims→"Claim extraction", connect→"Linking", archivist→"Archiving", decompose→"Decompose",
  panel→"Control Panel"; raw id kept in a `title`). Plus: Settings dropped the `(SPEC-0030)` id + "Dev-log"→
  "Diagnostic detail" + "egress payloads"→"data sent to external services"; **Recall References**
  (SPEC-0026) lead with the human label + capitalized kind, raw vault path demoted to a tooltip (the
  deep-link still uses the canonical `ref` via the index); Researchers "Egress"→"Data reach" (config
  chrome only — the egress *security control* stays "egress"), add-researcher now takes a **Name** and
  slugifies the id behind the scenes (no hand-typed slug), "via your gh"→"the GitHub CLI"; **Status**
  (SPEC-0030, stays a diagnostics surface) softened — cache paths → basenames (+ tooltip),
  "Canonical-writer lock"→"Write lock" (technical name in tooltip), friendly times + stage names;
  Activity "lineage"→"trace origin". Held per KB-PM: Sources "coming soon" rows + the raw audit
  drill-down (intentional AUDIT-5 transparency). Tests: `formatTime.test.ts`, `stageLabels.test.ts`,
  + updated view assertions (path-in-tooltip, slugify, display-name).
