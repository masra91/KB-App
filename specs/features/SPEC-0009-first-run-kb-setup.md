---
spec: SPEC-0009
key: SETUP
title: First-Run / KB Setup
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
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
| SETUP-1  | must     | On first run with no configured KB, the app guides the Principal through setup | none-yet | VISION-11 |
| SETUP-2  | must     | The Principal picks a root folder that becomes the vault root       | none-yet | VISION-12; DATA-9 |
| SETUP-3  | must     | The app confirms the root is a git repo; if not, offers to initialize one | none-yet | DATA-9; PRIN-13 |
| SETUP-4  | must     | The app detects Copilot availability on PATH; missing is a warning + guidance, not a hard block | none-yet | AUTO-11 |
| SETUP-5  | must     | The app writes initial KB structure + config and makes the first commit | none-yet | DATA-9; LIFE-2 |
| SETUP-6  | must     | The main process manages the configured KB; later launches load existing config (no re-onboarding) | none-yet | VISION-10 |
| SETUP-7  | should   | Setup configures one Instance; config is per-Instance               | none-yet | SCOPE-1,2 |
| SETUP-8  | should   | Configuration is editable later via the control panel               | none-yet | VISION-11 |

### SETUP-3 — Git-backed from the start
- **Status:** draft · **Priority:** must
- **Statement:** Setup **MUST** ensure the vault root is a git repository — confirming an
  existing one or initializing a new one — before the KB is considered ready.
- **Rationale:** Versioning, audit, and recovery (DATA-9/10/11) depend on git existing
  from the very first commit.
- **Traces:** DATA-9, PRIN-13
- **Verify:** none-yet

### SETUP-4 — Copilot detected, not required to finish
- **Status:** draft · **Priority:** must
- **Statement:** Setup **MUST** detect whether Copilot is available on PATH and surface
  the result, but **MUST NOT** block completing setup if it's missing (agent features
  degrade gracefully until resolved).
- **Rationale:** A user can set up and inspect their KB before wiring the BYOA agent; the
  KB substrate doesn't depend on Copilot.
- **Traces:** AUTO-11
- **Verify:** none-yet

## 5. Open questions

- [ ] **Initial KB structure** — what folders/files does a fresh vault get? (Sources/
      entities/outputs areas? a README? a `.kb/` config dir?) Pin during build.
- [ ] **Config location/format** — app-level (Electron userData, pointing at the active
      vault) vs. vault-level (`.kb/config.json` in the repo). Likely both: app remembers
      the active vault; vault holds its own KB config.
- [ ] **Copilot detection specifics** — exact binary/command to probe (`gh copilot`? a
      `copilot` CLI? the SDK's own check). Confirm against the actual SDK at build.
- [ ] **Multiple Instances** — switching/opening a different KB later: in scope for a
      later story; first story is single-KB.
- [ ] **`.gitignore` for the vault** — what should never be committed (caches, derived
      indexes that are rebuildable)?

## 6. Changelog

- 2026-05-30 — created (draft). The first build story: first-run KB setup (root + git +
  Copilot detection + initial commit + main-process management).
