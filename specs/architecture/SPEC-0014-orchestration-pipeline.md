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
| ORCH-6   | should   | Conflict-freedom comes from **globally-unique item ids** (disjoint write paths); v1 shipped a **serial** drain, **generalized to concurrent** execution by ORCH-17/18/19 on that same guarantee | test:src/kb/orchestrator.test.ts | DATA-9 |
| ORCH-7   | must     | The orchestrator (deterministic) owns all git/file **effects**; in v1 the agent session is **cognition-only** (thin agent) | test:src/kb/sourceDoc.test.ts | AUTO-3,4 |
| ORCH-8   | must     | Agent sessions use **BYOA GitHub Copilot**, reusing the user's existing credentials (no separate auth) — **CLI single-shot** for thin stages today; the **SDK** is the option for thick/interactive agents (ORCH-21/22) | test:src/kb/copilotAgent.test.ts | AUTO-11 |
| ORCH-9   | must     | The engine is **stage-agnostic**: the same harness drives later stages via a different instruction file + queue folder | none-yet | LIFE-1,3,8 |
| ORCH-10  | must     | The engine exposes **observable status** (queue depth, current item, processing state) for the app UI | test:src/kb/orchestrator.test.ts | VISION-11 |
| ORCH-11  | must     | Every pipeline action **emits an append-only audit event** (start, commit, failure), colocated with the item | test:src/kb/orchestrator.test.ts | DATA-10; LIFE-9 |
| ORCH-12  | must     | A **failed item is never lost**: it stays preserved and is flagged for review/retry, not dropped | test:src/kb/orchestrator.test.ts | INGEST-8,9; LIFE-6 |
| ORCH-13  | must     | The orchestrator is **idempotent / restartable**: re-poke or restart resumes from queue state without duplicating work | test:src/kb/orchestrator.test.ts | PRIN-1 |
| ORCH-14  | should   | A stage queue is a **contract** accepting a canonical `<ULID>/` unit **or** a foreign drop; the archivist **`normalize()`s** non-canonical entries (mint ULID, `origin: external`) — v1 builds the canonical path only | test:src/kb/ingest.test.ts | VISION-3; INGEST-7 |
| ORCH-15  | should   | The orchestrator is triggered by an **event poke** on capture-commit *and* a **periodic sweep** of the queue (recovers missed pokes, picks up foreign drops) | test:src/kb/orchestrator.test.ts | VISION-10 |
| ORCH-16  | must     | **Every model invocation is recorded for posterity**: which decision was used (model vs fallback), the runtime, the **requested** model, launch params, outcome (ok/error), and timing — colocated with the item. Tokens/cost are out of scope | test:src/kb/copilotAgent.test.ts | DATA-10; LIFE-9 |
| ORCH-17  | must     | **Stages run concurrently**: a stage's cognition + worktree writes happen **off a synced checkpoint, outside the lock**; multiple items/stages may run their agents at once | test:orchConcurrency.test.ts | DATA-9; PRIN-16 |
| ORCH-18  | must     | The shared canonical-writer lock guards **only the ff-advance**. On advance: unchanged base → fast-forward; base moved but item paths **disjoint** (unique-ULID keying, ORCH-6) → replay/rebase the item commit and advance; **same-path collision** → re-sync to new canonical and **retry** the item | test:canonicalAdvance.test.ts | ORCH-3,6; DATA-9 |
| ORCH-19  | must     | **Optimistic-concurrency safety**: collisions retry up to a bounded K; on exhaustion the item is **set aside for review** (ORCH-12), never dropped or half-applied; canonical history stays linear and clean (ORCH-3) | test:canonicalAdvance.test.ts | ORCH-3,12,13 |
| ORCH-20  | should   | The number of **concurrently in-flight** stage agents is **bounded** (a configurable cap) to control resource/cost; a cap of 1 degenerates to the v1 serial drain | test:orchConcurrency.test.ts | PRIN-16 |
| ORCH-21  | must     | The **agent runtime is pluggable** behind the decider/agent interface: an agent runs via the **CLI single-shot** (`copilot -p`) OR the **Copilot SDK** (Sessions/tools/streaming), chosen **per-agent where it makes sense**; a **deterministic fallback** is always retained (ORCH-7) | none-yet | ORCH-7,8; AUTO-11 |
| ORCH-22  | should   | Adopt the **Copilot SDK where its capabilities are load-bearing** (multi-turn sessions, agent-invoked tools/MCP, streaming) — Ask/Recall first, Research next, Connect/Reflect opportunistically; **thin single-shot stages stay on the CLI** until the SDK is **GA** and/or **concurrency-overhead evidence** (ORCH-20) justifies the server model. **Pin + age** the SDK per E1 (ENG-2,4,7) | none-yet | ORCH-20; ENG-2,4,7 |
| ORCH-23  | must     | A **process-wide copilot-concurrency ceiling** bounds the TOTAL in-flight `copilot` subprocesses across **all** spawners (every stage + jobs/Reflect + researchers + recall), independent of per-stage caps (ORCH-20). Every copilot spawner acquires from one shared semaphore; this is the safety bound that makes raising per-stage caps safe (cap×stages can't multiply into unbounded subprocesses → CLI/API rate-limit / CPU blowup). Ceiling is cores-aware, env-overridable, a per-Instance setting later | test:src/kb/copilotConcurrency.test.ts | ORCH-20; PRIN-16; STACK-9 |

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
- [x] **Parallelism & serialization** — RESOLVED (ORCH-17/18/19/20): **optimistic
      concurrency**. Stages run cognition concurrently off a synced checkpoint; the lock
      guards only the canonical ff-advance; disjoint-path items rebase cleanly (unique ids),
      same-path collisions re-sync + retry (bounded → set-aside). Impl sequences after the
      Visible Enrich epic.
- [x] **Recurring/scheduled triggers** — RESOLVED → **SPEC-0023 (Autonomous Jobs &
      Scheduler)**: a job registry + scheduler wakes agents (this harness) on a cadence;
      Reflect/Rumination (SPEC-0024) is the first job.
- [ ] **Audit global index** *(deferred)* — per-item `audit.jsonl` is contention-free;
      a derived "recent activity" index across items is a later optimization.

## 6. Changelog

- 2026-06-02 — **perf Phase 1: global copilot-concurrency ceiling + raised stage caps (ORCH-23; dogfood #4).**
  Added `src/kb/copilotConcurrency.ts` — one process-wide FIFO semaphore (`withCopilotSlot`/`acquireCopilotSlot`,
  cores-aware ceiling, `KB_COPILOT_MAX_CONCURRENCY` override) that **every** copilot spawner acquires from.
  Wired all live CLI spawners (decompose/connect/claims/archivist/reflect `defaultRunner`s). Raised
  **decompose + claims caps to 3** in `pipeline.ts` (the heaviest stages from the dogfood: claims ~87s /
  connect ~65s per drain were N sequential ~15-20s calls at cap=1) — the semaphore bounds total in-flight
  copilot processes so the higher caps can't fan out past the ceiling. ORCH-23 → `test:` (copilotConcurrency
  test proves the ceiling holds + is reached under a stage+job+researcher flood; 629 tests green). **Connect
  cap-raise is Phase 2** (needs its ephemeral-worktree migration, the #59 deferral). **recall (SDK) + the
  future live researcher runner adopt the same semaphore** — recall's acquire is a flagged decision (it's
  interactive/pull-only, bounding it behind background work could add Ask latency); researchers don't spawn
  copilot in prod yet (deferred to SPEC-0028 1d). A per-Instance cap/ceiling setting is the tracked fast-follow.
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
- 2026-06-01 — **concurrency model resolved (ORCH-17/18/19/20).** Narrowed the canonical-
  writer lock from the whole per-item cycle to **only the ff-advance**: stages run cognition
  concurrently off a synced checkpoint, and the advance is **optimistic** — disjoint-path
  items (unique-ULID keying, ORCH-6) rebase cleanly; same-path collisions re-sync + retry
  (bounded → set-aside, ORCH-12). Resolves the long-deferred *Parallelism & serialization*
  question and points *Recurring/scheduled triggers* at the new SPEC-0023 (Autonomous Jobs).
  **Impl sequences after the Visible Enrich epic (#30)** to avoid destabilizing the in-flight
  serial pipeline. Drove by the Principal's call to let stages "run 1 in parallel."
- 2026-06-02 — **Replay-epoch coupling (SPEC-0022 REPLAY-6) resolved.** The stage queue-readers
  derive "is this unit done?" by scanning each unit's append-only `audit.jsonl` for terminal
  stage markers (ORCH-4/13). Full Replay (SPEC-0022) resets that status **append-only** by
  appending a `replay-reset` epoch marker, so the readers MUST honor only markers after the
  latest epoch. Per the SPEC-0022 open question, this is implemented as **one shared helper**,
  `kb/replayEpoch.ts` `epochScopedLines(raw)`, integrated into `readDecomposeState`,
  `readClaimsState`, and `readConnectState` with a one-line change each — **not** duplicated per
  stage. The filter is a permanent, always-on capability of the production readers (a no-op when
  no epoch marker exists), so the post-replay rebuild runs the unmodified pipeline (SPEC-0022
  REPLAY-14) — it is *not* a replay-only code path. Any future stage's state-reader MUST route
  its audit scan through `epochScopedLines` to stay replay-correct.
- 2026-06-02 — **agent runtime: CLI + SDK, pluggable (ORCH-21/22).** The agent runtime is
  pluggable behind the decider/agent interface: **CLI single-shot** (`copilot -p`) for thin
  deterministic stages (today), and the **Copilot SDK** (Sessions / agent-invoked tools+MCP /
  streaming; public preview Apr 2026) for **thick/interactive agents where it makes sense** —
  **Ask/Recall is the first pilot** (ASK-12), then Research, Connect/Reflect opportunistically.
  Thin stages stay on the CLI until the SDK is **GA** and/or concurrency-overhead evidence
  (ORCH-20) justifies the server model; the deterministic fallback is always retained. Recorded
  alongside SPEC-0010 (stack), SPEC-0026 (ASK pilot), and a new **ENG-7** (E1): preview/fast-
  moving packages may be critical deps, but pin + age (≥7-day) — no hot-off-the-presses releases.
- 2026-06-02 — **ORCH concurrency slice 1 implemented (ORCH-17/18/19).** Narrowed the shared
  canonical-writer lock from the whole per-item cycle to **only the ff-advance**. New
  `kb/canonicalAdvance.ts`: `advanceOrCollide` (under-lock — fast-forward when the canonical is
  unchanged, cherry-pick *replay* a disjoint item onto a moved canonical keeping history linear
  (ORCH-3/6), or detect a same-path collision) + `withOptimisticAdvance` (prepare OFF the lock →
  advance UNDER it → re-sync + retry same-path collisions to a bounded K → set aside, ORCH-19).
  All four stages (archivist/decompose/claims/connect `*One`) refactored onto it: cognition +
  writes happen off a synced checkpoint, only the advance serializes. Each `*One` takes an
  optional `lock` (default mutex) so standalone calls still serialize. **Consequence:** because
  each stage already runs its own drain, narrowing the lock makes **cross-stage cognition overlap**
  (ORCH-17) — the rebase/collision paths run in production; the final canonical state is unchanged
  (linear, ORCH-3), only interleaving differs. Each stage's *own* drain stays serial (cap=1). Tests:
  `canonicalAdvance.test.ts` (helper interleavings: ff / disjoint-replay / collision / retry /
  K-exhaust→set-aside) + `orchConcurrency.test.ts` (stage-level disjoint-lands-linear + Connect↔Claims
  same-path collision→retry→converge, ORCH-3 asserted). **Deferred to slice 2:** ORCH-20 — within-stage
  concurrency cap>1 + ephemeral per-item worktrees (default cap stays 1); and narrowing Connect's
  link-promotion (`linkOne`) pass, which stays coarse-locked for now.
- 2026-06-02 — **ORCH concurrency slice 2 implemented (ORCH-20).** Within-stage concurrency cap.
  New `withEphemeralWorktree` (a fresh per-item worktree on `kb/<stage>-work-<ulid>` off the
  checkpoint, torn down after — prune-guarded against crash leaks) + `withConcurrentAdvance` (the
  ephemeral-worktree wrapper, sharing the same `advanceOrCollide` core as `withOptimisticAdvance`).
  Migrated archivist/decompose/claims `*One` onto `withConcurrentAdvance` (their old persistent
  per-stage worktrees removed); each stage's drain now processes up to a **configurable `cap`** items
  per batch (constructor param, default `DEFAULT_STAGE_CAP=1`), so cap=1 is output-identical to the
  serial drain and `pipeline.ts` is untouched — the cap-raise is a deliberate future one-liner.
  **Per design call (KB-PM option 2):** `withOptimisticAdvance` is left intact for JOBS (`jobStage`)
  — its per-job *persistent* worktree model differs — so the two wrappers share only the advance
  primitive. **Connect stays cap=1** (serial) this slice (cross-item dedup; its connectOne ephemeral
  conversion is a follow-up after DEV-1's `mergeNodes` extract — so no `connectStage.ts` seam touch).
  Tests: `withConcurrentAdvance` (happy/noop/K-exhaust + ephemeral teardown) + a cap=2 drain landing
  two items linearly (ORCH-3). Graduated ORCH-20 → `test:`. Deferred: raising the cap in pipeline.ts
  (Principal call); Connect/`linkOne` cap>1.
