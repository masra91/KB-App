---
spec: SPEC-0026
key: ASK
title: Ask & Recall (grounded NL query v1)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-01
updated: 2026-06-02
related: [SPEC-0003, SPEC-0004, SPEC-0005, SPEC-0006, SPEC-0007, SPEC-0014, SPEC-0020, SPEC-0025]
stage: Query
supersedes: null
---

# Ask & Recall (grounded NL query v1)

> The **"out" pillar**: the Principal asks the KB a natural-language question and gets a
> **grounded answer, traceable to evidence** — built by a **thick, structure-aware agent** that
> *navigates* the KB (entities, claims, `[[links]]`, metadata) with tools, **not blind
> text-search**. A **chat answer** by default, **savable as a persisted Output**. **Pull-only**.
> VISION-9 / LIFE-4.

## 1. Intent (the why / JTBD)

Half the product thesis is *"effortless recall out."* The enrich layer is now real on `main` —
deduped **entities** with their **claims**, `[[wikilinks]]`, and (SPEC-0025) **Properties/tags**.
Recall is the **payoff** that turns all that work into value to the Principal.

The job: *"ask in my own words and get back a rich, grounded answer full of **what and why**,
traceable to real evidence — without me searching, filtering, or remembering where anything
is."* (The day-in-the-life of SPEC-0003: fragments sent in come back as full quotes, context,
definitions, and connected prior work.)

## 2. The shape of a recall

- **Input** — an NL question, with conversational follow-ups.
- **Output** — a **grounded chat answer** by default; the Principal can **save it as an Output**
  (persisted synthesis under `outputs/`, **tagged as synthesis** with provenance — DATA-4 —
  promoted to `main`, evergreen). It re-enters the KB.
- **Grounded** — every substantive assertion **cites its evidence** (links to the
  source/claim/entity it rests on). No ungrounded claims presented as fact (PRIN-2, VISION-9).
- **Pull-only** — Principal-initiated; the KB never auto-pushes answers (AUTO-5).
- **Read-only w.r.t. the ontology** — recall reads sources/entities/claims; it **MUST NOT**
  mutate them. Its only write is the optional Output.

## 3. Agentic, structure-aware retrieval (the core idea)

Recall is **not** a fixed retrieve-then-synthesize pipeline over plain text. We have a rich,
structured, metadata-tagged graph and a capable agent — the agent should **exploit that
structure**. The recall agent is a **thick** GHCP/Copilot session (the SPEC-0014 harness, with
a larger budget than a stage) equipped with:

- **A recall skill / instruction file** teaching the **KB's structure**: the
  `sources/ entities/ claims/ outputs/` layout, the **metadata/tags/properties** model
  (SPEC-0025), the `[[wikilink]]` graph, and **provenance conventions** — so it navigates
  intentionally.
- **Tools it chooses among, per question:**
  - **structured KB queries** — entity lookup by name/alias, **tag/property filters**, claim
    lookup by subject, **`[[wikilink]]` graph traversal**;
  - **full-text** grep / ripgrep;
  - **optional Obsidian CLI** acceleration (its live index) **when Obsidian is running** —
    capability-detected, **never required**.
- It performs **multi-hop, entity-centric retrieval** — find the entity → read its claims →
  follow its links → check sources/metadata — reasoning about relevance, not dumping text.

> The point: *agents, not plain-text search.* Embeddings / a semantic index are a **possible
> later** enhancement (no timeline); v1 is structured + lexical + agent reasoning.

## 4. Requirements

| ID      | Priority | Statement (short)                                                                  | Verify   | Traces |
| ------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| ASK-1   | must     | The Principal can ask an **NL question** and receive a **grounded answer traceable to evidence** (links to the sources/claims/entities it rests on) | test:app/e2e/ask.e2e.ts | VISION-9; LIFE-4; PRIN-2 |
| ASK-2   | must     | Recall is **pull-only** — Principal-initiated; the KB never auto-pushes answers/reports | test:app/src/shell/views/askView.test.ts | AUTO-5 |
| ASK-3   | must     | Recall is **read-only w.r.t. sources/entities/claims** — it MUST NOT mutate the ontology; its only write is an optional **Output** | test:app/src/kb/recall.test.ts | DATA-1; AUTO-6 |
| ASK-4   | must     | Answers are produced by a **structure-aware agent** with a recall **skill** (KB layout + metadata/tags/properties + wikilink/provenance) and **tools** (structured KB queries, grep, optional Obsidian CLI), choosing among them per question — **not blind text-search** | test:app/src/kb/recallAgent.test.ts | ORCH-5,7,9; META-1 |
| ASK-5   | must     | Retrieval is **multi-hop, entity/metadata-aware** — traverses entities → claims → `[[wikilinks]]`, filters by tags/properties, exploiting KB structure | test:app/src/kb/recallTools.test.ts | CONNECT-3; META-1,3 |
| ASK-6   | must     | The Principal can **save an answer as an Output** — persisted under `outputs/`, **tagged as synthesis** with provenance to its evidence, promoted to `main` | test:app/src/kb/outputDoc.test.ts, app/src/shell/views/askView.test.ts | DATA-4; STAGING-3 |
| ASK-7   | must     | Every substantive assertion **cites its evidence**; the agent MUST NOT present ungrounded claims as fact, and **distinguishes KB-grounded from inferred** | test:app/src/kb/recall.test.ts | PRIN-2; VISION-9 |
| ASK-8   | should   | Recall is **conversational / multi-turn** — follow-ups refine within a session (the Ask/Chat surface) | test:app/src/shell/views/askView.test.ts | VISION-9; SHELL |
| ASK-9   | should   | **Obsidian CLI acceleration** is capability-detected and **never required** — core recall stays **headless** and works with Obsidian absent (optional viewer) | none-yet | STACK; PRIN-5 |
| ASK-10  | should   | Recall honors **scope/sensitivity + surfacing** — answers respect the surfacing policy and scope partitions | none-yet | SCOPE-11; SCOPE-1 |
| ASK-11  | must     | A recall run **emits an audit event** (question, what it retrieved, what it answered/saved) for transparency | test:app/src/kb/recall.test.ts | AUTO-8; LIFE-9 |
| ASK-12  | should   | Ask/Recall is the **first Copilot SDK pilot** (ORCH-21/22): it runs on the **SDK** (Sessions/tools/streaming) behind the agent interface — because tools (ASK-4), multi-turn (ASK-8), and streaming are load-bearing here — with the **deterministic/CLI fallback** retained; the SDK is **pinned + version-aged** (E1, not the SDK's sole user — adopt elsewhere where it makes sense) | test:app/src/kb/recallAgent.test.ts | ORCH-21,22; ENG-7 |
| ASK-13  | should   | Answers use **Wikipedia-style inline numbered citations** (`[1] [2]…`) + a References list; the agent is prompted/skilled to **cite the specific KB source/entity** each claim grounds on, by number | test:app/src/kb/recall.test.ts | ASK-7; VISION-9 |
| ASK-14  | should   | Citations are **dual-rendered** from one canonical target (the source/entity path): in the **Ask panel** each is a clickable link via the **Obsidian URI** (`obsidian://open?path=…`, opened with `shell.openExternal`) that jumps to the page in Obsidian; in a **saved Output** they are rewritten to native **`[[wikilinks]]`** so they work inside the vault | test:app/src/kb/citationLink.test.ts | ASK-6; ASK-13; VAULT-12,13 |
| ASK-15  | should   | The Ask panel **renders markdown** (so citations/emphasis/lists display, not raw `**`) via a lightweight pinned renderer | none-yet | SHELL; ENG-2,4 |
| ASK-18  | should   | **Recall answer length ADAPTS to the question — concise for facts, fuller for open-ended; always cited.** Today recall is **often too concise** (Principal). A **simple factual** question ("where did I stay in Mexico in 2025?") gets a **tight, direct answer**; an **open-ended / exploratory** question ("what do we know about my time in Mexico?") gets a **fuller, fleshed-out, multi-paragraph answer with the relevant detail** — the agent judges the question's shape and **scales the response** accordingly (don't truncate a rich answer to one line; don't pad a fact into an essay). **Inline `[^n]` citations + the References list are kept regardless** (ASK-7/13) — fuller means *more grounded detail*, never less grounding. Pairs with the ASK-17 budget (a fuller answer needs the room to compose). *(Principal: "Ask produces things often too concise; if it's a simple fact that's one thing, but if it's more open-ended I'd like a longer detail, but keep the inline sources.")* | test:app/src/kb/recall.test.ts (an open-ended prompt yields a multi-section cited answer; a fact prompt stays terse; both cite) — none-yet | ASK-1,7,13,17; PRIN-2 |
| ASK-17  | must     | **Recall has a real, CONFIGURABLE work budget — not a hard 60s that kills grounded queries.** ASK-16 fixed *capacity* (recall now acquires its priority slot), but recall **still fails** on the live build (`7a7b0e7`): the error moved to **`Timeout after 60000ms waiting for session.idle`** — NOT the `CopilotCapacityTimeoutError`. So recall **got its slot and started the agent**, but the Copilot **SDK session timed out before the agent could finish a grounded multi-hop query** over the KB (1007 entities). **60s is simply too tight for real recall.** Required: **(a)** the recall session's idle/run **timeout is raised to a sane default AND is Principal-configurable** — recall is the **interactive instance of the JOBS-17 work-depth/budget** knob (time + tool-calls/hops), so a genuine query has room to complete; **(b)** recall is **bounded-hop / scoped** so the structure-aware agent (ASK-4/5) **converges within budget** — a focused traversal with a sensible default hop/tool ceiling, not an unbounded crawl; **(c)** on genuinely exhausting the budget, recall returns its **best grounded partial + an honest "incomplete"** (ORCH-7), never a bare timeout. The bottleneck moved from *capacity* (ASK-16) to *session completion* — this closes it. *(Principal, live on `7a7b0e7`: "query still fails — 'where did i stay in mexico in 2025' — Timeout after 60000ms waiting for session.idle, not grounded in the KB.")* | test:app/src/kb/recall.test.ts (a query needing > the old 60s completes within the raised/configured budget against a fake slow session; budget-exhaustion returns an honest partial, not a bare throw) — none-yet | ASK-16; ASK-4,5; JOBS-17; SPEC-0044; ORCH-7; PRIN-5 |
| ASK-16  | must     | **Recall is interactive-priority — a foreground query NEVER starves behind the always-on pipeline.** Recall opens a Copilot SDK session and `sendAndWait`s for `session.idle`, but it **bypasses the global Copilot concurrency pool** (`copilotConcurrency.ts`) that every *pipeline* agent (connect/claims/decompose/reflect/research) acquires a slot from. So while ingestion runs (pool full at the 2–4 ceiling), recall fires an **extra** session *outside* the safety bound → CLI/API rate-limit + CPU/mem thrash (the exact harm the pool exists to prevent) → the agent can't make progress → **60s `session.idle` timeout, no answer.** Required: (a) recall is treated as **foreground/interactive** and acquires Copilot capacity through a **reserved/priority lane that preempts or reserves a slot ahead of background ingestion** — a Principal query gets capacity *promptly* even under continuous pipeline demand (**background yields to the human**, never the reverse); (b) recall **stops bypassing the global ceiling** so total concurrent `copilot` procs stay within the safe bound (no thrash); (c) if capacity genuinely can't be granted within a **bounded** time, recall **fails honestly and fast** — a clear "KB is busy ingesting — retry" or a degraded/ungrounded note (ORCH-7) — **never a silent 60s hang**. Generalizes to other Principal-initiated ops (Ask follow-ups, Explore). Pairs with QUIESCE drain (SPEC-0045) + stage-concurrency (SPEC-0044). *(Principal, 2026-06-08: "queries are timing out always — recall: Timeout after 60000ms waiting for session.idle… it's a read op on the repo root, is it trying to take a lock?" — not a git lock; recall is starving for Copilot capacity behind the pipeline, with no interactive priority.)* | test:app/src/kb/recall.test.ts, copilotConcurrency.test.ts (recall acquires a priority/reserved slot under a saturated pool and resolves within bound — fake pool; + bounded honest-fail when no slot frees) — none-yet | ORCH-20,21,23; AUTO-5; ASK-1; PRIN-5; SPEC-0044; SPEC-0045 |

## 4a. Design decisions (slice 1 — greenlit by KB-PM 2026-06-02)

Recall is **synchronous, pull-only, ephemeral** → a request/response **orchestrator loop**, NOT a
queue-drained stage (Decompose/Connect are autonomous + write evergreen; recall is not). The
existing stage agents are *thin* (one-shot, no tools); recall needs a *thick, multi-hop, tool-using*
agent, so:

- **F1 + ASK-12 — runs on the Copilot SDK (`@github/copilot-sdk`), with our control retained.**
  The agent is a real SDK **Session** (multi-turn, streaming) that invokes our tools as native
  **typed-tools** (`defineTool`) — the SDK owns the turn loop (ORCH-21,22; Recall is the SDK pilot).
  We keep the parts that make recall trustworthy: read-only enforcement, grounding/citation capture,
  and budget. The SDK is reached behind a thin injectable `RecallClient` seam so the engine stays
  unit-testable (tests drive a fake session; no CLI spawned). SDK pinned **exact `1.0.0-beta.7`**,
  ≥7-day-old (ENG-7). BYOA — the SDK drives the `copilot` CLI over JSON-RPC using its credentials.
  Deterministic fallback retained: SDK/CLI unavailable → honest ungrounded result (never fabricate).
- **Read-only tool surface (ASK-3 by construction):** `entityLookup`, `claimsForEntity`,
  `linkTraversal` (outgoing `[[links]]` + incoming backlinks), `readNode`, `readSource`, `grep`,
  registered as the session's **only** tools via the `availableTools` allow-list (+ `approveAll` over
  just those) — so the SDK's built-in shell/write tools are never exposed. **No mutation method
  exists.** Tag/property filters (SPEC-0025 META) and the Obsidian CLI accelerator (ASK-9) are
  **capability-gated** — not registered until those land; they slot in without changing the loop.
- **Grounding (ASK-7):** the agent finishes by calling a structured **`submitAnswer`** tool
  (answer + citations); the orchestrator **verifies every citation resolves on disk** before calling
  an answer grounded; no verifiable evidence → `grounded:false` (honest, never fabricated).
- **F3 — retrieval budget (scaled to graph size; dogfood #5):** the per-question retrieval-tool-call
  cap **scales to the entity-graph size** via `recallBudget(nodeCount) = clamp(4, 2 + ceil(0.5·nodeCount), 16)`
  (`nodeCount` = `.md` files under `entities/`, counted at recall start). A small KB is fully
  traversable in a few hops, so a fixed 12 just let the agent loop (the dogfood saw 12 calls +
  `truncated` on a ~6-node KB → ~5 now); a large KB keeps headroom up to 16. An explicit
  `opts.maxToolCalls` (callers/tests) still overrides. Enforced in the tool-handler wrappers: past
  the cap, retrieval returns an "exhausted — answer now" nudge and the result is flagged `truncated`.
  Complemented by a skill stop-criterion ("stop as soon as you can answer with grounded citations —
  don't exhaustively traverse"), which addresses the *cause* (the agent not self-stopping).
- **F5 — session state:** ephemeral; conversational `history` (ASK-8) is passed in by the caller,
  nothing persisted by the engine.
- **F2 — Outputs inert in v1 (accepted as working scope; KB-Lead confirming):** a saved Output lives
  in `outputs/` (not `sources/`), so the autonomous stages — which queue off `sources/` — won't
  re-enrich it. Re-enrichment deferred.
- **F4 (grounded-vs-inferred labeling convention) + F6 (Output template / citation rendering):**
  routed to KB-Lead; both are slice-3 concerns and don't gate the headless engine.

**Slicing:** (1) headless engine — tool surface + loop + grounded cited answer + audit ✅ *this
slice*; (2) Ask view + `kb:ask` IPC + multi-turn; (3) save-as-Output + `outputs/` promotion;
(4) Obsidian accelerator + scope/sensitivity.

**Slice-1 modules:** `app/src/kb/recall.ts` (types + read-only tool interface + SDK seam + the
orchestrator: tool-def building w/ budget+citation capture + grounding verification + ASK-11 audit),
`recallTools.ts` (read-only impl), `recallAgent.ts` (the recall skill + the `@github/copilot-sdk`
client adapter — the only module that imports the SDK). The `RecallClient` seam keeps everything
behind it substrate-agnostic and unit-testable.

## 5. User flows / surface

- **Ask UI** (chat-like, SPEC-0003 §4): type a question → grounded answer **with citations** →
  optionally **"save as report"** (Output).
- **Multi-turn** follow-ups within a session.

## 6. Out of scope (for now)

- **Embeddings / semantic index** — a possible later enhancement, **no timeline** (v1 is
  structured + lexical + agent reasoning).
- **Audience-facing export/sharing** of outputs beyond saving them in the vault.
- **Proactive / pushed answers** — pull-only (AUTO-5).
- **Cross-Instance / multi-scope federation** beyond honoring scope (SPEC-0005).
- **Any write-back beyond Outputs** — recall never mutates sources/entities/claims.

## 7. Open questions

- [x] **Output template (F6)** — resolved (KB-PM, slice 3): `outputs/recall/<ulid>.md` with
      frontmatter (`type:output`, `kind:recall-answer`, `id`, `created`, `question`, `grounded`,
      `generated:recall`) + title + grounded banner + the answer (inline `[n]` markers kept) + an
      **Evidence** section rendering **cited entities as `[[wikilinks]]`** (threading the report back
      into the graph) and claims/sources as path refs. No footnotes/over-spec.
- [x] **Grounding vs. reasoning labeling (F4)** — resolved (KB-PM, slice 3): **whole-answer** label
      (`grounded:true|false` frontmatter + a header banner) is enough for v1; the answer's inline
      `[n]` markers already show grounded claims. Finer inline inferred-vs-grounded marking **deferred**
      (bigger convention). Saving an **ungrounded** answer is **allowed**, with a prominent
      "⚠️ Not grounded — inferred" banner (honesty preserved by the label; blocking it would be paternalistic).
- [x] **Retrieval budget** — resolved (F3, slice 1): a configurable tool-call cap + exhaustion →
      answer-now + `truncated` flag. **Refined (dogfood #5):** the cap **scales to entity-graph size**
      (`recallBudget` clamp(4, 2+ceil(0.5·nodeCount), 16)) — a fixed 12 over-budgeted small KBs and let
      the agent loop; now a ~6-node KB gets ~5. Plus a skill stop-criterion (don't exhaustively traverse).
- [x] **Does a saved Output get re-enriched? (F2)** — resolved: **inert.** It lives in `outputs/`
      (not `sources/`) and carries `generated:recall`, so the autonomous stages (which queue off
      `sources/`) never re-enrich it. Re-enrichment remains deferred (no consumer needs it).
- [x] **Structured-tool surface** — resolved (slice 1): `entityLookup`, `claimsForEntity`,
      `linkTraversal`, `readNode`, `readSource`, `grep` (all read-only); tag/property + Obsidian
      capability-gated until SPEC-0025/ASK-9 land.
- [x] **Session state** — resolved (F5, slice 1): ephemeral; `history` passed in, nothing persisted.

## 8. Changelog

- 2026-06-09 — **ASK-17: recall needs a real, configurable work budget — ASK-16 was necessary but not sufficient.**
  On the shipped build (`7a7b0e7`) recall still timed out — but the error moved to `session.idle` (60s SDK), NOT
  `CopilotCapacityTimeoutError`: recall got its priority slot (ASK-16 worked) and the **agent session** then
  timed out before finishing a grounded multi-hop query over 1007 entities. 60s is too tight. ASK-17 = raise +
  make the recall session budget **Principal-configurable** (the interactive instance of JOBS-17 work-depth) +
  **bounded-hop** recall so it converges in budget + honest **partial** on exhaustion (not a bare timeout). The
  bottleneck moved capacity → session-completion; this closes it. Diagnosed live; impl unblocks on this spec.
- 2026-06-08 — **ASK-16: recall is interactive-priority — never starves behind the pipeline (Principal-reported).**
  Live test: "queries are timing out always — recall: Timeout after 60000ms waiting for session.idle… is it
  trying to take a lock?" Diagnosed: `session.idle` is the Copilot SDK agent-finished signal (not a git lock),
  and recall **bypasses the global Copilot concurrency pool** (`copilotConcurrency.ts`) that every pipeline agent
  acquires from — so under continuous ingestion (pool full at the 2–4 ceiling) recall fires an extra session
  outside the safety bound → CLI/API throttle + thrash → the agent can't finish in 60s. ASK-16 requires recall to
  be foreground/interactive: a **reserved/priority Copilot lane** that preempts/reserves capacity ahead of
  background ingestion (the human never starves behind the pipeline), recall stops bypassing the ceiling, and a
  bounded **honest fast-fail** replaces the silent 60s hang. Pairs with QUIESCE (SPEC-0045) + stage-concurrency
  (SPEC-0044). The core "effortless grounded recall out" JTBD was unusable during ingestion — this restores it.
- 2026-06-02 — **ASK-13 (inline numbered citations) → test:**. The recall agent now emits
  **Wikipedia-style inline `[n]` markers** in the markdown answer (skill instruction added), and the
  engine **guarantees the contract** the dual-render (ASK-14) relies on: `finalizeCitations` verifies
  each citation resolves on disk (ASK-7), **dedups by `ref`** (a target cited twice = one number,
  reused), and **renumbers the `[n]` markers densely** so they are 1:1 with the final `citations[]`
  (`[n]` → `citations[n-1]`, no gaps/dangling) — even after unresolvable citations are dropped. The
  References list is rendered by the UI from `citations[]` (single source of truth), not hand-written
  into the answer. Contract locked with DEV-4 (ASK-14). Unit-tested (`recall.test.ts`: dense renumber
  + dedup + drop-and-renumber + end-to-end through `recall()`; `recallAgent.test.ts`: the skill
  carries the `[n]` instruction). **Reconciled with #113** on rebase: this skill version
  `RECALL_SKILL_VERSION` → **`recall/v4-sdk`** carries BOTH #113's retrieval-budget stop-criterion and
  the inline-`[n]` citation instruction (one combined skill version, not two clashing `v3-sdk`s).
- 2026-06-02 — **retrieval budget scaled to graph size (F3 refinement; dogfood #5).** `recall()` now
  derives the tool-call cap from the entity-graph size — `recallBudget(nodeCount) = clamp(4, 2 +
  ceil(0.5·nodeCount), 16)`, `nodeCount` = `.md` under `entities/` counted at recall start — instead
  of a fixed 12. The dogfood saw 12 calls + `truncated` on a ~6-node KB (the agent looping on a fully-
  traversable graph); a 6-node KB now gets ~5. Added a recall-skill stop-criterion ("stop as soon as
  you can answer with grounded citations — don't exhaustively traverse"); bumped `RECALL_SKILL_VERSION`
  → `recall/v3-sdk`. Pure `recallBudget` + `countEntityNodes` unit-tested. Co-designed with the recall
  owner (DEV-3).
- 2026-06-01 — created (draft). The "out" pillar (VISION-9): NL question → **grounded, cited**
  answer by a **structure-aware thick agent** that wields tools (our structured KB queries,
  grep, **optional** Obsidian CLI) plus a recall **skill** teaching the KB's structure/metadata
  — **agentic, multi-hop, not plain-text search**. Chat answer by default, **savable as an
  Output** (DATA-4). Pull-only, read-only w.r.t. the ontology, epistemically honest. Forks
  resolved with the Principal: **chat + save-as-Output**; **hybrid retrieval** (in-house
  structured+lexical tools now; the official **Obsidian CLI needs a running app** so it stays an
  **optional accelerator**, preserving headless/Obsidian-optional; embeddings maybe-later, no
  timeline); **agentic structure-aware retrieval — agents, not plain search.** Researched the
  Obsidian CLI (shipped v1.12.4, Feb 2026 — remote-controls a running app) and headless
  alternatives.
- 2026-06-02 — **slice 1 (headless recall engine) built + graduated.** In-house tool-loop
  (`recall.ts`) + read-only tool surface (`recallTools.ts`) + thick structure-aware agent with a
  recall skill (`recallAgent.ts`), producing a grounded, citation-verified answer with an ASK-11
  audit event. Forks resolved by KB-PM: F1 in-house loop, F3 configurable budget cap, F5 ephemeral
  session; F2 inert-Output accepted as working scope (KB-Lead confirming); F4/F6 → KB-Lead (slice 3).
  Graduated `none-yet → test:` for **ASK-1, ASK-3, ASK-4, ASK-5, ASK-7, ASK-11** (requirement-traced
  tests: `recall.test.ts`, `recallTools.test.ts`, `recallAgent.test.ts`). ASK-1 is met at the engine
  level (NL question → grounded cited answer); its end-to-end UI surface lands in slice 2 (Ask view +
  `kb:ask` IPC), which is also where ASK-2/ASK-8 graduate. ASK-6 (save-as-Output) is slice 3; ASK-9/10
  are slice 4.
- 2026-06-02 — **slice 1 reworked onto the Copilot SDK (ASK-12 / ORCH-21,22; KB-Lead/PM mandate).**
  Per #43 (Recall = the first Copilot SDK pilot), the runtime substrate is now `@github/copilot-sdk`
  (pinned exact **`1.0.0-beta.7`**, ≥7-day-old, ENG-7): the agent is a real SDK Session that invokes
  our read-only tools as native typed-tools and finishes via a structured `submitAnswer` tool;
  read-only is enforced by the `availableTools` allow-list + `approveAll`. The in-house *control*
  (grounding/disk-verified citations, budget, skill, tool surface) is retained behind a thin
  injectable `RecallClient` seam (unit tests drive a fake session — no CLI). Deterministic fallback
  retained (SDK/CLI unavailable → honest ungrounded result). ASK-12 graduated `none-yet → test:`
  (seam + fallback + skill unit-tested; the **live SDK/CLI round-trip is e2e/manual** — the CLI isn't
  in the unit env, mirroring ORCH-8's CLI convention). 321 tests green; coverage gate passes.
- 2026-06-02 — **slice 2 (Ask surface) landed.** The Ask view (`VIEW_ASK` 💬, `app/src/shell/views/
  askView.ts`) + `kb:ask` IPC (resolves the active vault → `recall()`) + the `KbApi.ask` contract +
  preload bridge. Multi-turn within the session via in-view history (ASK-8); pull-only — recall runs
  only on the Principal's submit (ASK-2). Answer renders with its citations + ungrounded/truncated
  flags. **UI is genuinely tested** (PM acceptance): opened SPEC-0012's reserved **component tier
  (TEST-5)** via **happy-dom** (per-file `@vitest-environment`, node stays default) — `askView.test.ts`
  (render, multi-turn history, ungrounded/truncated flags, error, empty-question, pull-only); the
  `kb:ask` handler path in `ipc.test.ts` (active vault → recall, no-vault honesty, stub hook); and an
  **e2e happy-path** `app/e2e/ask.e2e.ts` (ask → grounded cited answer rendered) gated on
  `KB_ASK_E2E_STUB=1` (deterministic recall — the live SDK round-trip stays e2e/manual), CI-only.
  Graduated **ASK-1** (end-to-end surface), **ASK-2**, **ASK-8** `none-yet → test:`. Streaming deferred
  (request/response; tracked follow-up). 349 tests green; src/kb coverage gate passes. Broadening the
  unit-coverage gate to the now-open component tier is a follow-up once more views carry tests.
- 2026-06-02 — **slice 3 (save-as-Output) landed.** A "Save as report" action on a recall answer
  persists it as an inert KB Output: `outputDoc.ts` builds `outputs/recall/<ulid>.md` (F6 template —
  frontmatter + grounded banner + answer + an Evidence section rendering cited **entities as
  `[[wikilinks]]`**, claims/sources as refs); `pipeline.saveRecallOutput` writes it on `staging`,
  commits + `promote()`s to `main` under the canonical-writer lock (evergreen gate), and emits a
  conforming **`output`** audit event (AUDIT-2/11 — new actor in `kb/audit.ts`); `kb:saveRecallOutput`
  IPC + the askView "Save as report" button (saved state sticks per turn). **F2 inert** (in `outputs/`
  + `generated:recall` → stages skip it), **F4** whole-answer grounded label + ungrounded saves
  allowed with a banner, **F6** template — all resolved by KB-PM. Graduated **ASK-6** `none-yet →
  test:` (`outputDoc.test.ts` doc builder; `askView.test.ts` save flow incl. failure + ungrounded).
  ASK-9/10 remain slice 4.
- 2026-06-02 — **answer panel renders sanitized markdown (#93).** The Ask view previously showed raw
  markdown (literal `**asterisks**`); it now renders the answer via `marked` (MD→HTML) → **DOMPurify**
  (mandatory sanitize — the answer is LLM/ingested content; strips `<script>`, event handlers,
  `javascript:` URLs) before it touches the DOM (E1). Deps pinned exact + ≥7-day-old:
  `marked@18.0.4`, `dompurify@3.4.5`. The saved Output (ASK-6) stays raw `.md` (Obsidian renders it).
  `askView.test.ts` covers render + sanitization.
- 2026-06-02 — **ASK-14 dual-render citations landed.** One canonical citation `ref`, two surfaces,
  from a shared pure helper (`kb/citationLink.ts`). **Ask panel:** each inline `[n]` becomes an
  href-less, class-tagged anchor (`linkifyCitationMarkers`, run *before* DOMPurify so the `obsidian:`
  scheme never enters the DOM); clicking (or Enter/Space) hits a new `kb:openCitation(ref)` IPC →
  main resolves the **vault-relative `ref` to an absolute path with #30 containment** (`resolveContainedRel`
  — a crafted `..`/symlink ref can't deep-link outside the vault) → `shell.openExternal('obsidian://open?path='
  + encodeURIComponent(abs))`. A numbered **References** list renders from `citations[]` (same handler).
  **Saved Output:** `outputDoc` rewrites entities + claims to native `[[wikilinks]]` (a `source` is a
  directory → path ref), numbered `[n]` to match the answer's markers. The inline-panel deep-link maps
  `[n] → citations[n-1]` **by index**, which is correct because **ASK-13 (#121, now on main) enforces
  it**: `finalizeCitations` verifies-resolves (ASK-7), dedups by `ref`, and **dense-renumbers** the
  markers so they're gap-free + 1:1 with `citations[]` (no dangling markers) — so index-mapping needs
  no explicit key. (This PR was briefly held `none-yet` until ASK-13 landed, per QA-2 + KB-PM; now
  delivered whole — References + saved-Output wikilinks + inline deep-links all correct.) Covered by
  `citationLink.test.ts` (URI encoding + wikilink targets), `ipc.test.ts` (resolve/contain/open +
  escape rejection), `askView.test.ts` (clickable markers, References list, click/keyboard → IPC),
  `outputDoc.test.ts` (wikilink rewrite).
