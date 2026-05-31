---
spec: SPEC-0010
key: STACK
title: Tech Stack & App Shell Architecture
type: architecture
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-31
related: [SPEC-0003, SPEC-0006, SPEC-0007, SPEC-0009]
supersedes: null
---

# Tech Stack & App Shell Architecture

> The first architecture spec. Pins the stack so we can build the first story
> (SPEC-0009). Every choice traces back to a product requirement; tradeoffs noted
> honestly so a future reader knows *why*, not just *what*.

## 1. Intent (the why / JTBD)

The product specs deliberately avoided tech. To build, we now commit to a stack. The
constraints that drive it: cross-platform desktop (macOS/Windows), mostly **headless**
long-running process (VISION-10), a **git-backed markdown vault** (DATA-9), a future
**Obsidian plugin** (TypeScript), and a **BYOA agent layer via the GitHub Copilot SDK**
(AUTO-11). A TypeScript-centric stack lets us share one domain model across the desktop
app and the eventual plugin instead of writing it twice.

## 2. Decisions

### Shell — Electron + TypeScript
The desktop shell is **Electron**, written in **TypeScript**.
- **Why:** Principal familiarity (PRIN-5: understandable/approachable), mature
  cross-platform packaging, full Node APIs in the main process (filesystem, git, child
  processes for Copilot), and a TS ecosystem shared with the Obsidian plugin.
- **Tradeoff (honest):** heavier bundle / higher memory than Tauri. Accepted for
  familiarity and Node-in-main-process convenience. Revisit only if footprint becomes a
  real problem (Tauri remains a fallback; the domain model is deliberately shell-agnostic
  to keep that door open).

### Process model — main process is the manager
- **Main process** = the long-lived **manager/orchestrator** (the headless engine of
  VISION-10): owns the vault, git, config, scheduling, and (later) agents. Runs with or
  without a window.
- **Renderer(s)** = UI surfaces (the Setup window now; control panel, chat, capture
  later). Thin; talk to main via **IPC**.
- **Why:** matches "runs headless, surfaces only when needed." UI is replaceable; the
  manager is the durable core.

### Build/packaging — Electron Forge (Vite + TS)
Scaffold and package with **Electron Forge** using the **Vite + TypeScript** template.
- **Why:** official, batteries-included cross-platform packaging (macOS/Windows) and a
  fast Vite dev loop. Less glue than hand-rolling electron-builder + a bundler.

### Git — `simple-git` over system git
KB git operations use the **`simple-git`** library wrapping **system git**.
- **Why:** system git is robust, complete, and already a realistic dependency (Copilot/dev
  environments have it). Avoids reimplementing git.
- **Tradeoff:** requires git on PATH (we detect it, like Copilot). `isomorphic-git`
  (pure-JS, no system dep) is the fallback if portability demands it.

### Agent layer — GitHub Copilot SDK (BYOA), detection-only for now
The BYOA agent layer (AUTO-11) uses the **GitHub Copilot SDK**. For SPEC-0009 we only
**detect Copilot availability on PATH**; full SDK integration/auth is deferred to the
agent/enrich stories.
- **Why:** keeps the first story small; the vault substrate doesn't depend on Copilot.

### Environment — resolve the real PATH for GUI launches
The main process **augments `process.env.PATH` at startup** with the user's login-shell
PATH (plus common bin dirs like `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`)
before spawning any CLI. GUI launches (Finder/Dock/launchd) inherit a **minimal PATH**
(`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew/npm/`~/.local/bin`, so `copilot`/`gh`
(and `git`) aren't found even when they work in a terminal.
- **Why:** detection (SETUP-4) and every agent call (ORCH-8) shell out **by name**; without
  this they silently fail in the *packaged* app (the renderer/Finder launch). **Verified:**
  with the minimal PATH `copilot` is "command not found"; with the login-shell PATH (or its
  bin dir) prepended it runs.
- **How (testable):** the merge logic is a pure, DOM/Electron-free module; the shell probe
  (`$SHELL -ilc`) is injected, so it's unit-tested in the node tier (STACK-6 / TEST-2). No-op
  on Windows. No new dependency.

### Domain model — TypeScript, shell-agnostic
The vault/KB domain (sources, entities, outputs, provenance per SPEC-0007) is plain
**TypeScript with no Electron/Obsidian dependency**, so it can be shared with the future
plugin and survive a shell swap.

### Project layout — start single, evolve to workspaces
Start with the desktop app in **`app/`**. When the Obsidian plugin and shared model
arrive, evolve to npm/pnpm **workspaces** (`packages/desktop`, `packages/plugin`,
`packages/shared`). Incremental (PRIN-18); avoid premature monorepo overhead.

> **This repo (`KB-App`) is the *app source*, not a KB.** A KB is a separate,
> user-chosen **vault directory** (its own git repo) created at setup (SPEC-0009). The
> app must never treat its own source repo as a KB. For development we point the app at a
> throwaway vault **outside** this repo (never at `KB-App/`).

## 3. Requirements

| ID       | Priority | Statement (short)                                                  | Verify   | Traces |
| -------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| STACK-1  | must     | The desktop shell is Electron + TypeScript                          | none-yet | PRIN-5 |
| STACK-2  | must     | The main process is the long-lived manager (headless-capable); renderers are thin UI over IPC | none-yet | VISION-10 |
| STACK-3  | must     | The app packages for macOS and Windows (Electron Forge)             | none-yet | VISION-13 |
| STACK-4  | must     | KB git ops go through a library over system git (`simple-git`); git is a detected dependency | none-yet | DATA-9 |
| STACK-5  | must     | The agent layer uses the GitHub Copilot SDK (BYOA); SPEC-0009 needs only availability detection | none-yet | AUTO-11 |
| STACK-6  | must     | The KB domain model is TypeScript with no shell/plugin dependency (shareable, swappable) | none-yet | PRIN-4,14 |
| STACK-7  | should   | Layout starts as `app/`, evolving to workspaces (desktop/plugin/shared) when the plugin lands | none-yet | PRIN-18 |
| STACK-8  | must     | The app source repo is distinct from any KB vault; vaults are external user-chosen git repos; the app never treats its own repo as a KB | none-yet | DATA-9; SCOPE-1 |
| STACK-9  | must     | The main process resolves the user's real login-shell PATH at startup (merge + common-dir fallback) so spawned CLIs (Copilot, git) resolve regardless of launch context (Finder vs terminal); no-op on Windows | test:app/src/main/resolvePath.test.ts | SETUP-4; AUTO-11; STACK-4 |

## 4. Open questions

- [ ] **Package manager** — npm (default/familiar) vs. pnpm (better workspaces later).
      Leaning npm now; pnpm at the workspace move.
- [ ] **IPC shape** — typed IPC wrapper / contextBridge API surface between main and
      renderer. Define as the first window is built.
- [ ] **Copilot SDK specifics** — exact package name, auth model, and invocation; confirm
      against the actual SDK when the agent layer is built.
- [ ] **Config persistence** — electron-store (app-level) + a vault-level `.kb/config`?
      (Ties to SPEC-0009 open questions.)
- [ ] **Testing approach** *(own spec — "Testing Strategy")* — three levels the Principal
      wants: **unit** (code-level: domain model, vault/git logic), **component** (UI units),
      and **e2e** (**Playwright** driving the real Electron app/UI). This is what lets spec
      `Verify:` methods graduate from `none-yet` → `test:`. To be specced "in the fullness
      of time"; reserved in INDEX.

## 5. Changelog

- 2026-05-30 — created (draft). Pinned the stack for the first build story: Electron + TS,
  main-as-manager, Electron Forge (Vite+TS), simple-git over system git, Copilot SDK
  (detect-only now), shell-agnostic TS domain, `app/` layout evolving to workspaces.
- 2026-05-31 — added **STACK-9**: the main process resolves the user's login-shell PATH at
  startup so GUI-launched (Finder/Dock) packaged apps can find user-installed CLIs
  (`copilot`/`gh`/`git`). Fixes the "No Copilot CLI on PATH" false-negative and the silent
  enrich failure that followed from it. Pure merge logic is node-tested (`resolvePath.test.ts`);
  the shell probe is injected. No new dependency.
