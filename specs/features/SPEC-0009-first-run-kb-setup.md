---
spec: SPEC-0009
key: SETUP
title: First-Run / KB Setup
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-06-02
related: [SPEC-0005, SPEC-0006, SPEC-0007, SPEC-0010]
supersedes: null
stage: Cross-cutting (Control Panel / Setup)
---

# First-Run / KB Setup

> The first story we build. Stand up the app shell so the Principal can create and
> configure a KB: pick a root folder, confirm/create its git repo, confirm Copilot is
> available, and hand the configured KB to the main process that manages it.

## 1. Intent (the why / JTBD)

Before any capture, enrichment, or recall can happen, there must *be* a KB — a vault on
disk, under git, that an Instance is bound to (Fork 1). This story creates that, and in
doing so stands up the **walking skeleton**: the Electron main process as the long-lived
manager, the vault + git substrate (DATA-9), and Copilot detection for the future agent
layer. Everything else grows from here.

## 2. Scope

**In scope:** first-run experience; choosing/creating a vault root; git init/confirm;
Copilot availability detection; writing initial KB structure + config + first commit;
the main process loading an existing KB on later launches.

**Out of scope:** capture surfaces (tray/hotkey), agents/enrichment, multi-Instance
switching UI, full Copilot SDK integration/auth. Detection only here.

## 3. User flow

**Primary flow — first run (no KB configured):**
1. Launch the app. It finds no configured KB → shows the **Setup** flow.
2. **Pick root folder** — the Principal chooses (or creates) a directory to be the vault
   root. This is where the KB lives.
3. **Git** — the app checks if the root is a git repo. If yes, confirm and use it. If no,
   offer **"Initialize git repo here"** and create one on confirm (DATA-9).
4. **Copilot check** — the app detects whether the GitHub Copilot SDK/CLI is available on
   PATH and shows the result. Missing → a **warning with guidance** (agent features will be
   unavailable until resolved), not a hard block on finishing setup.
5. **Initialize** — write the initial KB structure + a config file, then make the **first
   commit**. The KB now exists.
6. **Done** — the main process is now managing this KB; the app transitions to its normal
   (initially minimal) running state.

**Returning flow — subsequent launches:**
- The app finds the existing config, loads the KB, and the main process manages it — **no
  re-onboarding**.

**Edit flow:**
- Configuration (root, etc.) is viewable/changeable later via the control panel.

## 4. Requirements

| ID       | Priority | Statement (short)                                                  | Verify   | Traces |
| -------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| SETUP-1  | must     | On first run with no configured KB, the app guides the Principal through setup | test:app/e2e/smoke.e2e.ts | VISION-11 |
| SETUP-2  | must     | The Principal picks a root folder that becomes the vault root       | test:app/src/main/ipc.test.ts | VISION-12; DATA-9 |
| SETUP-3  | must     | The app confirms the root is a git repo; if not, offers to initialize one | test:app/src/kb/vault.test.ts | DATA-9; PRIN-13 |
| SETUP-4  | must     | The app detects Copilot availability on PATH; missing is a warning + guidance, not a hard block | test:app/src/kb/copilot.test.ts | AUTO-11 |
| SETUP-5  | must     | The app writes initial KB structure + config and makes the first commit | test:app/src/kb/vault.test.ts | DATA-9; LIFE-2 |
| SETUP-6  | must     | The main process manages the configured KB; later launches load existing config (no re-onboarding) | test:app/src/main/appConfig.test.ts | VISION-10 |
| SETUP-7  | should   | Setup configures one Instance; config is per-Instance               | none-yet | SCOPE-1,2 |
| SETUP-8  | should   | Configuration is editable later via the control panel               | none-yet | VISION-11 |

### SETUP-2 — Picked folder becomes the vault root
- **Status:** draft · **Priority:** must
- **Statement:** The Principal chooses (or creates) a directory via the OS folder chooser,
  and **that folder becomes the vault root** the app manages — persisted as the active
  vault and handed to the main-process pipeline.
- **Rationale:** The vault root is the anchor for everything downstream (git, sources,
  entities, outputs); it must be exactly what the Principal selected.
- **Traces:** VISION-12, DATA-9
- **Verify:** test:app/src/main/ipc.test.ts (`kb:pickFolder` returns the chosen folder /
  null on cancel; after `kb:create` the picked folder is the active vault root reported by
  `kb:getState` and the path handed to `startPipeline`)

### SETUP-6 — Later launches load the existing KB (no re-onboarding)
- **Status:** draft · **Priority:** must
- **Statement:** The active vault is persisted in app-level config (`activeVaultPath` in
  Electron `userData`); on a subsequent launch the main process loads that KB and the app
  goes straight to its running state — **MUST NOT** re-run onboarding.
- **Rationale:** Setup is a one-time act; relaunching must resume the configured KB, not
  ask again.
- **Traces:** VISION-10
- **Verify:** test:app/src/main/appConfig.test.ts (config round-trips through `userData`,
  survives a simulated restart, tolerates a corrupt file) + app/src/main/ipc.test.ts (a 2nd
  launch reports vault + config via `kb:getState` — the renderer's onboarding gate — and
  `initPipeline` resumes managing it; a vanished vault falls back to setup rather than a
  broken shell)

### SETUP-3 — Git-backed from the start
- **Status:** draft · **Priority:** must
- **Statement:** Setup **MUST** ensure the vault root is a git repository — confirming an
  existing one or initializing a new one — before the KB is considered ready.
- **Rationale:** Versioning, audit, and recovery (DATA-9/10/11) depend on git existing
  from the very first commit.
- **Traces:** DATA-9, PRIN-13
- **Verify:** test:app/src/kb/vault.test.ts (`createKb` inits git; refuses non-repo when init off)

### SETUP-4 — Copilot detected, not required to finish
- **Status:** draft · **Priority:** must
- **Statement:** Setup **MUST** detect whether Copilot is available on PATH and surface
  the result, but **MUST NOT** block completing setup if it's missing (agent features
  degrade gracefully until resolved).
- **Rationale:** A user can set up and inspect their KB before wiring the BYOA agent; the
  KB substrate doesn't depend on Copilot.
- **Traces:** AUTO-11
- **Verify:** test:app/src/kb/copilot.test.ts (detects `copilot`/`gh copilot`; reports unavailable cleanly)

## 5. Open questions

- [x] **Initial KB structure** — resolved (implemented): `sources/`, `entities/`,
      `outputs/` (DATA-1 three kinds, each with `.gitkeep`), `.kb/config.json`, a
      `README.md`, and a vault `.gitignore`.
- [x] **Config location/format** — resolved (implemented): **both**, as predicted —
      app-level `kb-app.config.json` in Electron `userData` holds `activeVaultPath`;
      vault-level `.kb/config.json` holds the KB's identity (`id`, `name`, `createdAt`).
- [x] **Copilot detection specifics** — resolved (implemented, detection-only): probes
      `copilot --version` then `gh copilot --version` on PATH; reports availability +
      detail. Exact BYOA SDK invocation still deferred to the agent stories.
- [ ] **Multiple Instances** — switching/opening a different KB later: in scope for a
      later story; first story is single-KB.
- [x] **`.gitignore` for the vault** — resolved (implemented): ignores `.kb/cache/`
      (rebuildable) and `.DS_Store`.

## 6. Changelog

- 2026-05-30 — created (draft). The first build story: first-run KB setup (root + git +
  Copilot detection + initial commit + main-process management).
- 2026-05-30 — implemented in `app/` (Electron, SPEC-0010). Domain `kb/` (vault +
  copilot), main-process IPC + app config, preload bridge, Setup UI renderer. Validated:
  typecheck, lint, headless smoke test (inspect → init git → scaffold → commit →
  idempotent re-run), and a full Forge package build. `Verify:` methods stay `none-yet`
  pending the Testing Strategy spec (automated unit/e2e). Resolved 4 open questions above.
- 2026-05-30 — SETUP-3/4/5 graduated `none-yet → test:` under the SPEC-0012 harness
  (`vault.test.ts`, `copilot.test.ts`).
- 2026-05-30 — SETUP-1 graduated `none-yet → test:` — the Playwright e2e smoke
  (`app/e2e/smoke.e2e.ts`) drives the built app with clean userData and asserts the first-run
  Setup wizard renders. Green locally (macOS) + CI (opt-in `e2e` job, macOS + Windows).
- 2026-06-02 — SETUP-2/6 graduated `none-yet → test:` under the SPEC-0012 harness.
  SETUP-2: `app/src/main/ipc.test.ts` (mocked electron — `ipcMain`/`dialog`/`BrowserWindow`
  + real `createKb` in a temp git repo) proves the picked folder flows through `kb:pickFolder`
  → `kb:create` → persisted active vault → `kb:getState`/`startPipeline`. SETUP-6:
  `app/src/main/appConfig.test.ts` (config persists in mocked `userData`, survives a simulated
  relaunch, tolerates corruption) + `ipc.test.ts` (2nd launch loads vault+config and resumes
  via `initPipeline`; vanished vault falls back to setup). Both `must` reqs now test-verified.
