---
spec: SPEC-0017
key: SHELL
title: App Navigation Shell
type: architecture
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0002, SPEC-0009, SPEC-0010, SPEC-0012, SPEC-0013]
supersedes: null
---

# App Navigation Shell

> The chrome that lets the app grow from one screen to many — a persistent
> navigation rail and a single content region that views plug into — without
> rewriting existing views and without burying capture.

## 1. Intent (the why / JTBD)

Today the renderer is a single screen: first-run **Setup** (SPEC-0009) or, once a
KB is active, the **Capture** panel (SPEC-0013). As the product fills out its
lifecycle (SPEC-0004) it will need many surfaces — recall, control panel,
explore, audit. We need somewhere to *put* them.

The job this shell is hired for: **turn the one-screen renderer into a host that
can carry an open-ended set of views, so each new feature is "register a view"
rather than "rewrite the renderer."** It must do this while keeping the thin-UI /
shell-agnostic discipline (STACK-2, STACK-6) and keeping **capture front and
center** (capture is the product's sacred fast path — SPEC-0013).

Without it: every new surface fights the same single root element, view-switching
is reinvented per feature, and capture risks being demoted as screens multiply.

## 2. Scope

**In scope:**
- A persistent **navigation rail** (left sidebar) plus one **content region**,
  shown once a KB is active.
- A small **view registry** + selection model: the list of views, which one is
  active, the default, and switching between them.
- Relocating the existing **Capture** view into the shell unchanged in behavior.
- A neutral **placeholder** view ("Coming soon") that proves the shell carries
  more than one view.
- A **Settings** view (v1: **display-only**) surfacing the active KB and Copilot
  status from existing IPC.
- Factoring the selection logic as a **shell-agnostic module** so it is unit-tested
  in the node tier without a component harness (respects SPEC-0012 TEST-5).

**Out of scope (for now):**
- Any real content behind the placeholder view (it is a stub on purpose).
- Editing configuration from Settings — **switching the active KB** is specced as
  a deferred `should` (SHELL-10), not built in v1.
- The richer **Control Panel** (reserved key `PANEL`): agents/sources/tasks. The
  shell is the *host* it will later live in; Settings v1 is only a first slice.
- Standing up a jsdom/component test harness — the component tier stays reserved
  (SPEC-0012 TEST-5); the shell's DOM is covered by e2e in CI.
- Theming, multi-window, and the separate global quick-capture surface (reserved
  key `QCAP`).

## 3. User flows / feature surface

The "user" is the Principal, in the main window.

**Primary flow — move between views:**
1. Launch with a configured KB. The app shows the **shell**: a left rail listing
   **Capture**, the **placeholder**, and **Settings**, with **Capture** active.
2. Click a nav item → the content region swaps to that view and the item is marked
   active. Exactly one view is active at a time.
3. Click back to **Capture** → the capture panel is shown again, with any
   in-progress (unsent) capture text preserved (SHELL-8 → capture is sacred).

**Settings flow (v1 — display-only):**
1. Select **Settings**. It shows the active KB's **name** and **vault path**, and
   **Copilot availability**, all read from existing IPC (`getState`, the Setup
   inspection). No edits in v1.

**First-run gate (unchanged):**
- With no configured KB, the app shows the **Setup** flow (SPEC-0009) full-screen,
  *without* the shell. The shell appears only once a KB is active.

**Growth flow (the point of this spec):**
- A future feature adds a view by registering it once (id, label, mount fn);
  existing views are untouched and the nav rail lists it automatically.

## 4. Requirements

| ID       | Priority | Statement (short)                                                                 | Verify   | Traces |
| -------- | -------- | --------------------------------------------------------------------------------- | -------- | ------ |
| SHELL-1  | must     | When a KB is active, the app shows a persistent left navigation rail + one content region | none-yet | PRIN-17; STACK-2 |
| SHELL-2  | must     | Selecting a nav item shows that view and marks it active; exactly one view is active at a time | test:app/src/shell/navModel.test.ts | PRIN-17 |
| SHELL-3  | must     | The shell ships three views — Capture, a neutral placeholder, and Settings        | test:app/src/shell/navModel.test.ts | PRIN-18; SETUP-8 |
| SHELL-4  | must     | Capture is the default/active view on launch (capture stays the sacred fast path) | test:app/src/shell/navModel.test.ts | VISION-13; CAPTURE-1 |
| SHELL-5  | should   | Views come from one extensible registry; adding a view is a single registration with no edits to existing views | test:app/src/shell/navModel.test.ts | PRIN-16; PRIN-18 |
| SHELL-6  | must     | The view-selection logic is a shell-agnostic module (no Electron/DOM), unit-tested in the node tier; DOM stays a thin render layer | test:app/src/shell/navModel.test.ts | STACK-2; STACK-6; TEST-2; TEST-5 |
| SHELL-7  | must     | Settings (v1) displays the active KB name + vault path and Copilot availability   | none-yet | SETUP-8; SETUP-4 |
| SHELL-8  | should   | Switching away from Capture and back preserves in-progress (unsent) capture text  | none-yet | CAPTURE-2 |
| SHELL-9  | should   | Setup remains a pre-shell gate; the shell appears only once a KB is active         | none-yet | SETUP-1; SETUP-6 |
| SHELL-10 | should   | Settings (later) lets the Principal switch the active KB folder, reusing Setup's pick/inspect/open and re-persisting the active vault | none-yet | SETUP-2; SETUP-8 |
| SHELL-11 | may      | Views are switchable via keyboard                                                 | none-yet | PRIN-17 |

### SHELL-1 — The shell exists when a KB is active
- **Status:** draft · **Priority:** must
- **Statement:** When a KB is active, the renderer **MUST** present a persistent
  navigation rail (left sidebar) alongside a single content region that hosts the
  active view.
- **Rationale:** A stable place to put many surfaces is the precondition for every
  other view; doing it now avoids per-feature reinvention.
- **Traces:** PRIN-17, STACK-2
- **Verify:** none-yet (will be: e2e smoke in CI + manual)

### SHELL-2 — One active view, clearly indicated
- **Status:** draft · **Priority:** must
- **Statement:** Selecting a navigation item **MUST** show that view in the content
  region and mark the item active; **exactly one** view **MUST** be active at a time.
- **Rationale:** Predictable, single-focus navigation; the invariant is what the
  selection model enforces and tests assert.
- **Traces:** PRIN-17
- **Verify:** test:app/src/shell/navModel.test.ts (one-active invariant; unknown-id no-op). DOM wiring covered by e2e (CI).

### SHELL-3 — Three views ship in v1
- **Status:** draft · **Priority:** must
- **Statement:** The shell **MUST** register three views: **Capture** (the existing
  panel), a **neutral placeholder** ("Coming soon"), and **Settings**.
- **Rationale:** Two real views + one stub proves the host carries more than one
  surface and gives Settings a home (first slice of SETUP-8).
- **Traces:** PRIN-18, SETUP-8
- **Verify:** test:app/src/shell/navModel.test.ts (NAV_VIEWS = capture/placeholder/settings, in order)

### SHELL-4 — Capture is the default view
- **Status:** draft · **Priority:** must
- **Statement:** On launch with a KB active, **Capture MUST** be the default active
  view.
- **Rationale:** Capture is the product's sacred fast path — VISION-13 ranks "quick
  capture, effortless recall" above all; the shell must not demote it as views multiply.
  **Deliberate v1 behavior:** launch always lands on Capture (not the last-open view);
  see §5 if we ever revisit.
- **Traces:** VISION-13, CAPTURE-1
- **Verify:** test:app/src/shell/navModel.test.ts (DEFAULT_VIEW_ID = capture; model default active)

### SHELL-5 — Adding a view is one registration
- **Status:** draft · **Priority:** should
- **Statement:** Views **SHOULD** be supplied through a single registry such that
  adding a view requires one registration (id, label, mount) and **no edits** to
  existing views.
- **Rationale:** The whole point is cheap growth; coupling new views to old ones
  would defeat it (PRIN-16/18).
- **Traces:** PRIN-16, PRIN-18
- **Verify:** test:app/src/shell/navModel.test.ts (adding a view leaves others + selection intact)

### SHELL-6 — Selection logic is shell-agnostic and unit-tested
- **Status:** draft · **Priority:** must
- **Statement:** The navigation/selection logic (registry, active id, default,
  switch) **MUST** live in a module with no Electron or DOM dependency and **MUST**
  be unit-tested in the node tier; DOM rendering **MUST** remain a thin layer over
  it.
- **Rationale:** Lets us cover real, requirement-traced behavior in the existing
  node runner **without** building the jsdom/component harness SPEC-0012 TEST-5
  deliberately reserves; the DOM glue is covered by e2e.
- **Traces:** STACK-2, STACK-6, TEST-2, TEST-5
- **Verify:** test:app/src/shell/navModel.test.ts (model has no DOM dependency; runs in node)

### SHELL-7 — Settings v1 shows the KB and Copilot status
- **Status:** draft · **Priority:** must
- **Statement:** The Settings view **MUST** display the active KB's name and vault
  path and the detected Copilot availability, sourced from existing IPC.
- **Rationale:** An honest, useful Settings tab with zero new persistence — a first,
  read-only payment on "configuration editable via the control panel" (SETUP-8).
- **Traces:** SETUP-8, SETUP-4
- **Verify:** none-yet (DOM view; will be: e2e + any pure helper unit)

### SHELL-8 — Capture text survives view switches
- **Status:** draft · **Priority:** should
- **Statement:** Navigating away from Capture and back **SHOULD NOT** lose
  in-progress (unsent) capture text.
- **Rationale:** Capture is fire-and-forget and sacred (CAPTURE-2); losing a
  half-typed thought to a stray click is a trust violation.
- **Traces:** CAPTURE-2
- **Verify:** none-yet (guaranteed by mount-once + show/hide; will be: e2e)

### SHELL-9 — Setup stays a pre-shell gate
- **Status:** draft · **Priority:** should
- **Statement:** The first-run Setup flow (SPEC-0009) **SHOULD** remain a
  full-screen gate shown only when no KB is configured; the shell **SHOULD** appear
  only once a KB is active.
- **Rationale:** Onboarding has no use for navigation; keeping it separate avoids a
  half-populated shell during setup.
- **Traces:** SETUP-1, SETUP-6
- **Verify:** none-yet (will be: e2e/manual)

### SHELL-10 — Switch KB from Settings (deferred)
- **Status:** draft · **Priority:** should
- **Statement:** The Settings view **SHOULD** later let the Principal switch the
  active KB folder, reusing Setup's pick/inspect/open and re-persisting the active
  vault (`kb-app.config.json`).
- **Rationale:** The natural completion of SETUP-8; deferred from v1 to keep the
  first shell change light (the reload-into-new-vault flow is its own slice).
- **Traces:** SETUP-2, SETUP-8
- **Verify:** none-yet

### SHELL-11 — Keyboard navigation
- **Status:** draft · **Priority:** may
- **Statement:** Views **MAY** be switchable via keyboard shortcuts.
- **Rationale:** Faster for a keyboard-first Principal; not essential for v1.
- **Traces:** PRIN-17
- **Verify:** none-yet

## 5. Open questions

- [ ] **Spec type** — modeled as `architecture` (a structural host other features
      plug into). Could be argued as `feature`; revisit if it accretes user-facing
      flows beyond plumbing.
- [x] **Persisting last-active view** — resolved for v1: the shell **always defaults
      to Capture on launch** (SHELL-4), rather than restoring whichever view was last
      open. This is a deliberate behavior, recorded so it's findable: if we later want
      launch to restore the last-active view (persisted in `kb-app.config.json`),
      change SHELL-4 and this note together.
- [ ] **Relationship to `PANEL`** — when the Control Panel spec lands, does Settings
      fold into it, or stay a peer view? (Currently: Settings is a standalone view
      and the first slice of SETUP-8.)
- [ ] **Component tier graduation** — at what point does growing shell UI justify
      graduating SPEC-0012 TEST-5 (a real component harness) over node-tested logic
      + e2e? Likely **soon** as views multiply — keep evaluating, don't let it drift.
      (For now: SHELL-6 keeps the logic node-testable, no harness.)

## 6. Changelog

- 2026-05-30 — created (draft). Defines the navigation shell: left rail + content
  region, a shell-agnostic view registry/selection model (node-tested per TEST-5),
  Capture relocated as the default view, a neutral placeholder, and a display-only
  Settings view (first slice of SETUP-8). Switch-KB deferred (SHELL-10).
- 2026-05-30 — **v1 implemented** in `app/`. Added a DOM-free `navModel` + `NAV_VIEWS`
  registry (`app/src/shell/`), unit-tested in the node tier; a thin `shell.ts` left
  rail + content host that lazily mounts views and switches by visibility (so capture
  text survives a switch, SHELL-8); Capture relocated into the shell as the default
  view; a neutral placeholder; and a display-only Settings view (KB name + path +
  Copilot). Graduated `Verify:` of SHELL-2/3/4/5/6 → `test:`. SHELL-1/7/8/9 are
  DOM-only and remain `none-yet` pending an e2e smoke (CI-only, per TEST-9 / TEST-5),
  matching the CAPTURE-1/12 precedent. SHELL-10/11 deferred.
- 2026-05-30 — renumbered SPEC-0016 → **SPEC-0017** (the number SPEC-0016 was taken
  by CLAIMS, merged concurrently); key `SHELL` unchanged, so requirement IDs are
  stable.
