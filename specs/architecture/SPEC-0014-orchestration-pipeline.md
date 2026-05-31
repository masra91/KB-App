---
spec: SPEC-0014
key: ORCH
title: Orchestration & Pipeline Engine
type: architecture
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0004, SPEC-0006, SPEC-0008, SPEC-0010, SPEC-0011]
supersedes: null
stage: Cross-cutting (the headless engine)
---

# Orchestration & Pipeline Engine

> The headless engine that turns the KB's lifecycle stages into running pipelines:
> a deterministic loop scripts a git worktree and feeds work items, one at a time,
> to **fresh, disposable agent sessions** — keeping all dirty state hidden in the
> worktree so the canonical vault only ever advances by clean commits.

## 1. Intent (the why / JTBD)

SPEC-0004 names **Orchestration** as cross-cutting infrastructure — *"the headless
engine scheduling/running Enrich, automated Ingest, and Reflect as recurring
jobs/agents."* This spec pins **how that engine actually works** as a reusable
pattern, established by the first stage that needs it (Ingest → archive; SPEC-0013)
and reused unchanged by every later stage.

The job it's hired for: **run autonomous, multi-item agent work against the KB
safely** — without polluting the canonical vault the Principal (and Obsidian) sees,
without one item's context contaminating the next, and without ever losing an item
if an agent crashes mid-flight.

Without it, every feature reinvents "watch for work, run an agent, commit the
result, don't corrupt the vault" — and dirty agent state leaks into the live KB.

**The pattern, in one breath:** *orchestration is deterministic; cognition is
disposable.* A brainless loop owns the queue, the git worktree, and all effects;
the brain is a fresh agent session that sees exactly one item and then dies.

## 2. Scope

**In scope:**
- The long-lived **orchestrator** process model (headless; survives window close).
- The **worktree isolation** model: stages run in a vault-repo worktree; the
  canonical root tree advances only by completed commits.
- The **filesystem queue** model: a known folder *is* the durable work queue.
- The **disposable per-item session** model: one fresh agent invocation per item.
- The **agent runtime**: BYOA Copilot CLI, invoked non-interactively, reusing the
  user's existing credentials.
- **Status observability** and **audit emission** for the engine.

**Out of scope (for now):**
- Any specific stage's *content* logic (what "archive" or "enrich" decides) — those
  live in the owning feature spec; this spec only provides the harness.
- **Parallelism across items/stages**, recurring/scheduled triggers, and a job DAG —
  v1 is a single serial drain per stage, poke-driven (see Open Questions).
- The Control Panel UI (SPEC-0004 cross-cutting) beyond the minimal status read.

## 3. Architecture (the harness)

Three layers; only one has a brain.

| Layer | What it is | LLM? | Lifetime |
| ----- | ---------- | ---- | -------- |
| **Main process** | The Electron app manager (SPEC-0009). Spawns and supervises the orchestrator; reads status for the UI. | no | app lifetime |
| **Orchestrator** | Plain code (a loop). Owns the worktree, drains the queue, spawns one agent session per item, performs all git/file **effects**, emits audit + status. | no | long-lived (spawned process) |
| **Stage agent** (e.g. *archivist*) | One disposable `copilot -p` session per item, empty context each time, driven by a stage **instruction file**. Returns a decision. | **yes** | one item |

```
 main ──spawns──► ORCHESTRATOR (vault worktree at <vault>/.kb/worktrees/<stage>)
                     │  sync worktree to main; for each item in <queue>/ :
                     │    ├─ spawn fresh stage agent  ──►  copilot -p  (sees 1 item)
                     │    │                                  └─ returns decision
                     │    ├─ orchestrator applies effects (move + write + git commit)
                     │    └─ fast-forward canonical main; refresh root working tree
                     ▼
            CANONICAL VAULT (root tree) — always clean; what Obsidian/the user sees
```

**Why each property holds:**
- **Crash-safe / restartable** — the queue folder is the only source of truth for
  "what's left"; an item leaves the queue *only* when its result is committed. Re-poke
  or restart simply re-reads the folder (ORCH-4, ORCH-13).
- **No cross-item contamination** — a brand-new session per item means item *N+1*
  can't inherit item *N*'s context or the agent's earlier "decisions" (ORCH-5).
- **Canonical vault stays clean** — all work happens on a branch inside the worktree;
  only completed, committed items fast-forward onto the canonical tree (ORCH-2,3).
- **Reusable** — Enrich/Reflect are the same harness with a different instruction
  file pointed at a different queue folder (ORCH-9).

## 4. Requirements

| ID       | Priority | Statement (short)                                                  | Verify   | Traces |
| -------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| ORCH-1   | must     | The app runs a long-lived orchestrator that keeps processing while no window is open (headless) | none-yet | VISION-10 |
| ORCH-2   | must     | Stage work runs in a dedicated git **worktree of the vault repo**, isolating dirty state from the canonical tree | test:src/kb/orchestrator.test.ts | DATA-9 |
| ORCH-3   | must     | The canonical vault (root) tree advances **only** by completed, committed work; it is never left dirty for the user | test:src/kb/orchestrator.test.ts | VISION-4; DATA-9 |
| ORCH-4   | must     | A known queue **folder is the durable work list**; an item leaves it only once its processed result is committed | test:src/kb/orchestrator.test.ts | INGEST-8; PRIN-1 |
| ORCH-5   | must     | Each work item is handled in a **fresh, isolated agent session** (empty context) — no cross-item contamination | test:src/kb/copilotAgent.test.ts | AUTO-2 |
| ORCH-6   | should   | v1 drains each stage **serially** (one item at a time); conflict-freedom comes from globally-unique item ids | test:src/kb/orchestrator.test.ts | DATA-9 |
| ORCH-7   | must     | The orchestrator (deterministic) owns all git/file **effects**; in v1 the agent session is **cognition-only** (thin agent) | test:src/kb/sourceDoc.test.ts | AUTO-3,4 |
| ORCH-8   | must     | Agent sessions use the **BYOA Copilot CLI non-interactively**, reusing the user's existing credentials (no separate auth in our flow) | test:src/kb/copilotAgent.test.ts | AUTO-11 |
| ORCH-9   | must     | The engine is **stage-agnostic**: the same harness drives later stages via a different instruction file + queue folder | none-yet | LIFE-1,3,8 |
| ORCH-10  | must     | The engine exposes **observable status** (queue depth, current item, processing state) for the app UI | test:src/kb/orchestrator.test.ts | VISION-11 |
| ORCH-11  | must     | Every pipeline action **emits an append-only audit event** (start, commit, failure), colocated with the item | test:src/kb/orchestrator.test.ts | DATA-10; LIFE-9 |
| ORCH-12  | must     | A **failed item is never lost**: it stays preserved and is flagged for review/retry, not dropped | test:src/kb/orchestrator.test.ts | INGEST-8,9; LIFE-6 |
| ORCH-13  | must     | The orchestrator is **idempotent / restartable**: re-poke or restart resumes from queue state without duplicating work | test:src/kb/orchestrator.test.ts | PRIN-1 |
| ORCH-14  | should   | A stage queue is a **contract** accepting a canonical `<ULID>/` unit **or** a foreign drop; the archivist **`normalize()`s** non-canonical entries (mint ULID, `origin: external`) — v1 builds the canonical path only | test:src/kb/ingest.test.ts | VISION-3; INGEST-7 |
| ORCH-15  | should   | The orchestrator is triggered by an **event poke** on capture-commit *and* a **periodic sweep** of the queue (recovers missed pokes, picks up foreign drops) | test:src/kb/orchestrator.test.ts | VISION-10 |
| ORCH-16  | must     | **Every model invocation is recorded for posterity**: which decision was used (model vs fallback), the runtime, the **requested** model, launch params, outcome (ok/error), and timing — colocated with the item. Tokens/cost are out of scope | test:src/kb/copilotAgent.test.ts | DATA-10; LIFE-9 |

### ORCH-3 — The canonical vault is always clean
- **Status:** draft · **Priority:** must
- **Statement:** All pipeline mutation **MUST** happen on a branch inside a worktree;
  the canonical root working tree **MUST** only ever advance to a committed state
  (e.g. fast-forward + refresh) and **MUST NOT** be left with dirty/partial work the
  user or Obsidian could observe.
- **Rationale:** The root tree *is* the live KB the Principal reads; hiding dirty
  agent state in a worktree is what makes autonomous churn safe.
- **Traces:** VISION-4, DATA-9
- **Verify:** test:src/kb/orchestrator.test.ts

### ORCH-5 — One fresh brain per item
- **Status:** draft · **Priority:** must
- **Statement:** The orchestrator **MUST** start a new agent session per work item
  with no carried-over context, instructions/skills loaded fresh each time.
- **Rationale:** Shared context lets one item's content (or a stale "decision") bleed
  into the next; per-item isolation keeps each archival/enrichment honest and makes
  the session boundary double as the crash + commit boundary.
- **Traces:** AUTO-2
- **Verify:** test:src/kb/copilotAgent.test.ts

### ORCH-7 — Thin agent in v1 (deterministic effects)
- **Status:** draft · **Priority:** must
- **Statement:** In v1 the agent session **MUST** be cognition-only — it returns a
  decision; the orchestrator performs the file moves, metadata writes, and git
  commits. The agent **MUST NOT** be granted shell/write tools at this stage.
- **Rationale:** The archival move is mechanical; keeping git history deterministic
  and denying the LLM hands removes a whole risk surface. Later stages (Enrich)
  graduate to a "thick" agent where autonomous tool-use earns its keep.
- **Traces:** AUTO-3, AUTO-4
- **Verify:** test:src/kb/sourceDoc.test.ts

### ORCH-16 — Record every model invocation
- **Status:** draft · **Priority:** must
- **Statement:** Every invocation of a model/agent runtime **MUST** be recorded for
  posterity, colocated with the item it acted on: which decision was actually used
  (`copilot` vs deterministic `fallback`), the runtime, the **requested** model, the
  launch params/flags, the outcome (`ok` or the error/fallback reason), and timing.
  Token/cost/usage is explicitly **out of scope**.
- **Rationale:** Non-deterministic steps are where trust erodes silently; recording
  *what we launched and what happened* from the very first model call makes every
  non-deterministic decision auditable and reproducible-by-intent. Cheap to start now,
  expensive to retrofit.
- **Limitation (honest):** while the model is left unpinned (no `--model`), we record
  the *requested* model as `default` — Copilot does not report back the model it
  actually resolved, so certainty requires pinning a model (future).
- **Traces:** DATA-10, LIFE-9, PRIN-5
- **Verify:** test:src/kb/copilotAgent.test.ts

## 5. Open questions

- [x] **Poke delivery** — resolved: **event poke + periodic sweep** (ORCH-15). Poke for
      responsiveness; the sweep recovers missed pokes and foreign drops (a crude
      folder-watch the future WATCH surface formalizes).
- [x] **Worktree lifecycle** — resolved: **persist** one long-lived worktree at
      `<vault>/.kb/worktrees/<stage>` (gitignored), synced to main on a work branch each
      drain; sync is idempotent.
- [x] **Main ↔ orchestrator transport** — resolved: the app reads **queue depth directly
      from the queue folder**; the orchestrator writes a small **`status.json` to
      `.kb/cache/`** (gitignored, rebuildable) for current-item/worker-state. No fragile
      IPC protocol in v1.
- [x] **Copilot invocation shape** — resolved: **single-shot** `copilot -p --no-ask-user
      --model <m>`, no tools (effects are the orchestrator's; ORCH-7), agent returns a
      validated **JSON decision**. Autopilot is reserved for thick-agent stages (Enrich).
- [x] **Stage instruction-file format** — resolved: a **versioned prompt template**
      shipped with the app (role + rules + JSON output schema), composed by the
      orchestrator and passed via `-p`. Per-stage file; an `AGENTS.md` layer may be added
      later. The reusable expression of "per-role instruction files".
- [ ] **Parallelism & serialization** *(deferred)* — when do we run items/stages
      concurrently, and what's the merge/serialize-writer policy then? (DATA open Q.)
- [ ] **Recurring/scheduled triggers** *(deferred)* — Proactive Intake / Reflect run
      on a schedule; the trigger model beyond poke+sweep is future.
- [ ] **Audit global index** *(deferred)* — per-item `audit.jsonl` is contention-free;
      a derived "recent activity" index across items is a later optimization.

## 6. Changelog

- 2026-05-30 — created (draft). The headless engine pattern: deterministic
  orchestrator + worktree isolation + filesystem queue + disposable per-item Copilot
  sessions (thin agent in v1). Established for Ingest→archive (SPEC-0013), reusable
  by all later stages.
- 2026-05-30 — resolved v1 mechanics: poke + periodic sweep (ORCH-15); persist one
  worktree at `.kb/worktrees/<stage>`; status via queue-folder count + `.kb/cache/
  status.json`; single-shot `copilot -p` returning JSON; versioned per-stage prompt
  template via `-p`. Added ORCH-14 (queue-as-contract / foreign-drop `normalize`) and
  ORCH-15 (trigger). Parallelism, scheduled triggers, and audit global-index stay parked.
- 2026-05-30 — **Phase A implemented** in `app/kb/orchestrator.ts`: worktree-isolated
  queue drain (sync → decide → move into date-sharded `sources/` + `source.md` → per-item
  commit → ff-advance root) + `status.json` + poke/sweep + restartable. The per-item
  decision is a **deterministic decider** standing in for the Copilot thin agent (ORCH-7);
  Phase B swaps it via the same `ArchivistDecider` interface. Two v1 implementation
  choices vs. the resolution above: the loop runs **in-process** (serialized by a mutex),
  not a spawned OS process — headless still holds via the live main process; and the
  worktree lives under the already-gitignored **`.kb/cache/worktrees/archivist`** (no
  `.gitignore` churn). Graduated `Verify:` of ORCH-2/3/4/6/7/10/11/12/13/15 → `test:`;
  ORCH-1/5/8/9/14 await Phase B (Copilot session, normalize) + e2e.
- 2026-05-31 — **Phase B implemented** (`app/kb/copilotAgent.ts`): the archivist runs a
  disposable single-shot `copilot -p` session per item (ORCH-5/8), reusing existing
  Copilot credentials, returning a validated JSON decision; any failure (no CLI, timeout,
  bad output) falls back to the deterministic decision. Harness-focused — the decision
  stays conservative (CAPTURE-10); the value is the proven disposable-session + parse +
  fallback pattern Enrich will reuse. Added foreign-drop `normalizeInbox` (ORCH-14):
  loose inbox files are adopted into canonical `origin: external` units and committed.
  Subprocess is injectable → CI stays deterministic, no real creds. Graduated ORCH-5/8/14
  → `test:`. Still `none-yet`: ORCH-1 (headless main, e2e) and ORCH-9 (needs a 2nd stage).
- 2026-05-31 — added **ORCH-16** (record every model invocation): an `AgentTrace` (via /
  runtime / requested-model / params / ok / error / ms / at) rides on the archivist
  decision → written into the item's `archived` audit event and surfaced truthfully in
  `source.md`'s `archivedBy` (e.g. `copilot (default)` vs `deterministic (copilot failed:
  …)`). No tokens/cost. Resolved-model limitation noted (unpinned → recorded as `default`).
  `Verify:` → `test:`.
