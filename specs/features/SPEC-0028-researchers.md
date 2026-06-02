---
spec: SPEC-0028
key: RESEARCH
title: Researchers (Enrich & Research — external corroboration & expansion)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0003, SPEC-0004, SPEC-0005, SPEC-0006, SPEC-0007, SPEC-0014, SPEC-0018, SPEC-0020, SPEC-0023, SPEC-0026, SPEC-0027]
stage: Enrich
supersedes: null
---

# Researchers (Enrich & Research — external corroboration & expansion)

> The KB's **external enrichment**: the Principal adds **researchers** — configurable agents
> (prompt + tools/MCP + egress + budget) that reach *outside* the KB to **corroborate and
> expand**. Built-ins: **Web**, **Code**, **M365/WorkIQ**, plus **custom**. What they bring
> back lands as **cited secondary sources** that re-enter the normal pipeline. Invoked **inline
> during indexing** ("saw this term — learn more"), **on a schedule / via rumination** ("poll
> this feed daily"), and **on-demand**. Egress-filtered, read-only-world, bounded. VISION-6,8.

## 1. Intent (the why / JTBD)

The pipeline today enriches **internally** (Decompose → Connect → Claims). The day-in-the-life
(SPEC-0003) also wants the KB to **fetch the transcript, search the internet for prior art,
query databases for telemetry** — to make a private fragment legible by pulling in the world's
context. JTBD: *"go find out more about the things in my KB — from the web, my work tools, my
code — and fold it in, cited, without me searching."*

This is **Enrich & Research** (SPEC-0004 Stage 2). It is *not* a single stage: it's a **fleet
of researchers** the Principal configures, **invoked from** the indexing flow, rumination, and
recall.

## 2. The model — a parallel registry of researchers

Researchers are a **parallel capability**, related to the pipeline by **invocation** (not a
stage, not a job — though they share infra with Autonomous Jobs, SPEC-0023):

- **Generic core** — a researcher is `prompt + tools/MCP + egress tier + budget + scope`.
- **Built-in templates** over the core (each with a typed config block): **Web · Code ·
  M365/WorkIQ**. Plus **custom** researchers (own prompt + MCP + tools).
- **Invocation modes:**
  - **Inline (indexing):** a stage hits a trigger ("unknown term", "mentioned announcement")
    and emits a `research-request`. *Canonical: "I saw this term, can I learn more?"*
  - **Scheduled / rumination:** a standing prompt + cadence, or a Reflect job that invokes
    researchers. *Canonical: "any email updates I should know?", "poll this feed daily."*
  - **On-demand:** the Principal (or Ask/Recall) asks a researcher to go find something.

## 3. The flow

```
indexing stage → emits `research-request` signal (what + why + context)   [async, non-blocking]
                      │
                      ▼
  DISPATCHER (deterministic): filter enabled researchers by declared SCOPE + EGRESS TIER
                      │  fan-out to all eligible
                      ▼
  each eligible researcher SELF-NOMINATES (cheap relevance check):
     relevant → research (BYOA auth, egress-gated, bounded) → write CITED secondary source(s)
     not      → no-op + audit
                      │
                      ▼
  secondary sources (origin: secondary, provenance + citations) land in `sources/`
                      │
                      ▼
  re-enter the NORMAL pipeline → Decompose → Connect → Claims
     corroborate → new claims (cited);  conflict → Review (SPEC-0018)
```

A request may be answered by **several** researchers (code + email + web), each producing its
own cited secondary source. Findings are **never trusted blindly** — they flow through claims +
Review like any source.

## 4. Built-in templates (v1)

- **Web** — egress tier **`public-web`**. Config: allowed domains/sites, topics, recency
  window, depth. Tools: web search/fetch. *"Get the press release / prior art for X."*
- **Code** — egress tier **`local-only`** (+ GitHub/Azure DevOps **reads** via BYOA). Config:
  repo path, worktree-under-repo (y/n), git-refresh policy, **PR provider** (GitHub *or* Azure
  DevOps), branches/PRs to watch. **Strictly read-only** (RESEARCH-10). *"Answer questions
  about this codebase / what changed in these PRs."*
- **M365 / WorkIQ** — egress tier **`internal-tenant`**. Config: M365 MCP/tenant (OAuth),
  surfaces (mail/calendar/SharePoint/Teams). *"Any updates in my email/meetings I should know?"*
- **Custom** — generic core: own prompt + MCP servers + tools + declared egress tier.

## 5. Requirements

| ID         | Priority | Statement (short)                                                                 | Verify   | Traces |
| ---------- | -------- | --------------------------------------------------------------------------------- | -------- | ------ |
| RESEARCH-1 | must     | Researchers are a **parallel registry** of Principal-configured external agents — a **generic core** (prompt + tools/MCP + egress + budget + scope) with **built-in templates** (Web/Code/M365) and **custom** | none-yet | VISION-6; AUTO-4 |
| RESEARCH-2 | must     | A researcher is **invoked** three ways — **inline during indexing**, **scheduled/rumination**, **on-demand** — and is **not** a pipeline stage | none-yet | VISION-6,8 |
| RESEARCH-3 | must     | Inline invocation is **async + non-blocking**: a stage emits a `research-request` **signal** (what + why + context) like its existing `signals[]`; the stage never waits on the network | none-yet | ORCH-3; DECOMP; CLAIMS |
| RESEARCH-4 | must     | Routing = **deterministic eligibility filter → fan-out → researcher self-nomination**: the dispatcher filters enabled researchers by declared **scope + egress tier**; each eligible researcher self-nominates (cheap relevance check → research, else no-op + audit); a **max fan-out** caps it; one request may yield **several** researchers' findings | none-yet | AUTO-4 |
| RESEARCH-5 | must     | A researcher's output is **immutable secondary sources** in `sources/` (the fetched artifact and/or a grounded findings-note) that **re-enter the normal pipeline** (Decompose→Connect→Claims) | none-yet | DATA-2; LIFE-11; CANON |
| RESEARCH-6 | must     | Findings are **citation-rich**: each secondary source records **provenance** (researcher id, request/query, **external origin/URL**, timestamp), and any findings-note **cites the external sources** it rests on | none-yet | DATA-10; PRIN-2; ASK-7 |
| RESEARCH-7 | must     | Corroborate/conflict uses the **normal flow** — secondary sources become claims (cited); conflicts with existing claims route to **Review** — no special corroboration engine | none-yet | CLAIMS; REVIEW; CONNECT |
| RESEARCH-8 | must     | **Egress is gated per-researcher by tier** (`public-web`/`internal-tenant`/`local-only`): the dispatcher only feeds a researcher KB content **at-or-below** the matching sensitivity, and outbound queries are built from allowed content only | none-yet | AUTO-4; SCOPE-11 |
| RESEARCH-9 | must     | Researchers **authenticate via BYOA** — the M365 MCP's own OAuth, `gh`, `az` — **KB-App stores no secrets** | none-yet | AUTO-11 |
| RESEARCH-10| must     | **Read-only world** (AUTO-6): no side-effecting external actions. The **Code researcher** is strictly read-only — clone/worktree/fetch/pull/read-files/read-PRs (GET) only; **never** commit, push, comment, open PRs, or touch the user's working tree; its worktree is an **isolated, gitignored** read workspace kept current by fetch/pull | none-yet | AUTO-6 |
| RESEARCH-11| must     | Research is **bounded**: per-researcher **budget** (cost/calls/rate) + a **depth limit** on research→finding→`research-request` chains; the researcher is **prompted to self-moderate** (runaway/drift awareness); on hitting the depth limit it **escalates to Review** ("continue?"); a **global per-Instance ceiling** is the hard backstop | none-yet | VISION-8; REVIEW; AUTO-12 |
| RESEARCH-12| must     | **Untrusted-content defense**: fetched external content is treated as **data, never instructions**; researchers are prompted/structured accordingly and constrained by egress tier (limits exfiltration), read-only world (limits action), a **per-researcher tool/MCP allowlist**, and budget; findings are **marked externally-sourced** | none-yet | PRIN-19,20; AUTO-6 |
| RESEARCH-13| must     | MCP servers / external tools are **third-party deps** — **vetted, pinned, version-aged** | none-yet | ENG-1,2,4,7 |
| RESEARCH-14| should   | Researchers are a **prime Copilot SDK adopter** (tools/MCP, sessions, ORCH-21/22) — behind the agent interface, deterministic fallback retained | none-yet | ORCH-21,22 |
| RESEARCH-15| must     | Researchers are managed in a **dedicated "Researchers" view** in the Control Panel Manage section: add-from-template, configure (prompt/scope/egress/budget/MCP), enable/disable, **run-now**, see last-run + findings/citations + escalations | none-yet | PANEL-1; VISION-11 |
| RESEARCH-16| must     | **v1 ships** the framework + three built-in templates — **Web** (public-web), **Code** (local-only, read-only), **M365/WorkIQ** (internal-tenant, OAuth) — plus **custom** | none-yet | VISION-6 |
| RESEARCH-17| must     | The Researchers view **exposes per-researcher configuration** — a **free-text instructions box** (the agent prompt: *what to look for, which sites/sources, which WorkIQ surfaces, which repo*) **+ scope** — so the Principal can steer each researcher. Templates show **short labels** (`Public Web` · `WorkIQ/M365` · `Local Repository` · `Custom`), long descriptions as helper text | none-yet | PANEL-1; [#109](https://github.com/masra91/KB-App/issues/109) |

## 6. User flows / surface

- **Add a researcher** (Control Panel → Researchers): pick a template → set prompt/scope/egress
  tier/budget/MCP → enable. **Run-now** to test.
- **Inline:** Decompose sees an unknown term → emits a `research-request` → Web (+ others)
  self-nominate → a cited secondary source about the term appears and gets connected.
- **Scheduled:** an M365 researcher with "summarize new project-related mail, daily" → cited
  secondary sources → claims → surfaced.

## 7. Out of scope (for now)

- **Contributing actions** (open PRs, send mail, post) — read-only world (AUTO-6) holds; a
  deliberate future change, not v1.
- **Fine-grained egress redaction** — v1 is **tier-based content gating** (RESEARCH-8);
  span-level scrubbing is later.
- **App-managed secret store** — BYOA only (RESEARCH-9).
- **A central routing *agent*** — routing is deterministic + self-nomination (RESEARCH-4).

## 7a. Delivery slices (v1)

Security-dominant, so v1 lands in three reviewable slices, lowest-egress-risk first:

- **Slice 1 — framework spine + Web + Researchers view.** The generic-core registry, the
  `research-request` signal + the deterministic **dispatcher** (eligibility filter → fan-out →
  self-nomination → max-fan-out cap), the **Web** researcher (`public-web`), **secondary-source
  re-entry**, **bounds** (budget + depth-limit→Review + global ceiling), the **untrusted-content
  posture**, the `researcher` audit actor, and the **Researchers** Control-Panel view. Invocation:
  **inline + on-demand + scheduled** (scheduled = a `researcher` job type, see decision D5).
- **Slice 2 — Code researcher** (`local-only`, strictly read-only, isolated gitignored worktree;
  RESEARCH-10) — its own PR + security review.
- **Slice 3 — M365/WorkIQ** (`internal-tenant`, OAuth MCP) + **custom** researcher polish.

## 8. Resolved decisions (Slice 1 locked) + escalations

Forks resolved with KB-PM (D1–D3, D5, D6a are KB-PM/owner calls; D4-policy and the broader D6
mapping are **escalated to the Principal**, governing Slices 2/3 — not Slice 1):

- **D1 — `research-request` schema:** `{ id, ts, by: { stage, sourceId?, entityId? }, what, why,
  context, egressHint?, dedupKey }`, carried on the existing `signals[]` as `type:
  'research-request'` (the payload in the signal). A producer is **any** stage **or Reflect** —
  not a special emitter (D5).
- **D2 — dedup / rate:** `dedupKey = hash(normalized what + subject)`; the dispatcher keeps a
  per-epoch **seen-set** + a debounce window in `.kb/research/`, coalescing duplicates so a busy
  Decompose can't fan the same request out repeatedly.
- **D3 — self-nomination cost:** a **deterministic pre-filter** (scope + egress tier + template
  topic match) narrows the eligible set **before** any paid relevance check; decisions are
  **cached per (researcher, topic)** with a TTL; a **max-fan-out** caps eligible researchers.
- **D4 — findings-note vs raw artifact (v1 posture):** default is a single **grounded, cited
  findings-note** as the secondary source; the raw fetched artifact is stored **only when small +
  license-safe**; **never** large/PII raw by default. *(Principal to ratify the licensing/PII
  policy; the conservative default errs safe and is not a Slice-1 blocker.)*
- **D5 — scheduled-researcher ↔ Jobs seam:** a scheduled researcher runs **as a `researcher` job
  type** on the SPEC-0023 `JobScheduler` (reusing single-flight, posture, budget, journal,
  ephemeral worktree, write-sink guard). `research-request` is a **signal any producer emits**
  (pipeline stages AND Reflect); **Reflect emits a request, it does not invoke researchers** — the
  **dispatcher is the single router**, keeping behaviors composable.
- **D6a — egress ↔ content (Slice 1):** the **Web** researcher builds outbound queries **only
  from the `research-request`'s explicit `what`/`context`** — **never** arbitrary KB content.
  Least-privilege egress that ships safely **without depending on SPEC-0005** (sensitivity is
  hardcoded `internal` today) and is the floor any future egress model preserves.
- **D6 (escalated) — egress-tier ↔ sensitivity mapping** (proposed `public-web → shareable`,
  `internal-tenant → up to internal/confidential`, `local-only → any`) **and whether to prioritize
  SPEC-0005 classification** so public-web researchers can later be fed KB content: **Principal
  call.** Governs relaxation in Slices 2/3, not Slice 1.

## 9. Changelog

- 2026-06-02 — **Slice 3 (M365/WorkIQ researcher) design locked** (KB-PM-signed-off; KB-Developer-3).
  The M365 researcher is an adapter behind the existing `ResearchFn` seam (registered into
  `selectResearchFn`'s per-template switch, alongside Web/Code — no `makeResearchDeps` change),
  mirroring the Web adapter: asserts `egressTier === 'internal-tenant'`, builds a **request-only**
  query via `buildOutboundQuery` (D6a — `what`+`context` only, never KB content), runs a Copilot
  session that frames returned mail/docs as **DATA, never instructions** (RESEARCH-12), returns a
  cited findings-note ingested as an externally-sourced secondary source via `runResearcher`
  (RESEARCH-5/6), graceful no-finding on any error. **Decisions (PM rulings):**
  (1) **OAuth-MCP** via the Copilot SDK's `SessionConfig.mcpServers` (an M365 Graph **read-only** MCP
  server registered on the session; `availableTools` allow-list keeps it read-only — RESEARCH-9/10);
  the server is an **injectable seam** (deterministic stub for unit tests; concrete server chosen at
  env-time). (2) **OAuth owned by the Electron main process** — the token **never** touches the
  renderer and is **redacted** in the dev log (PRIN-19). (3) **Egress = internal-tenant, request-only
  + tenant-allowlist** — the M365 analog of the Web domain-allowlist; the adapter enforces the
  configured `tenantId` (the user's **own tenant only**), so it ships under request-only **regardless**
  of the open content-feeding ruling (RESEARCH-8). (4) **MCP server choice deferred to env-time**
  (Microsoft-published Graph MCP if read-only-scopable + E1-vettable, else a thin one we control —
  a supply-chain call escalated to the Principal with the env ask). **Build-now vs env-gated:**
  build the adapter + injectable MCP-session seam + tenant-allowlist + request-only + egress-tier
  assertion + M365 skill + Manage-view config block + **unit tests** (deterministic injected
  session); **env-gated** (waits on the Principal's M365 env/creds — Entra app w/ read-only Graph
  scopes + a test tenant): the real Graph MCP wiring + OAuth flow + live tenant validation/e2e.
  Discharges part of RESEARCH-16 (the third built-in) once the adapter lands.
- 2026-06-02 — **Slice 1 design locked** (KB-PM-greenlit; KB-Developer-5). Resolved the open
  questions into decisions D1–D6a (§8): `research-request` schema on `signals[]`; dispatcher
  dedup ledger; deterministic self-nomination pre-filter + cache; conservative cited-findings-note
  default; scheduled researchers as a `researcher` **job type** on the SPEC-0023 scheduler with the
  **dispatcher as sole router** (Reflect emits requests, doesn't invoke); and **least-privilege
  egress** for Slice-1 Web (queries built only from the explicit request, no SPEC-0005 dependency).
  Added the 3-slice delivery plan (§7a). Two items **escalated to the Principal** (licensing/PII
  raw-artifact policy; the egress-tier↔sensitivity mapping + SPEC-0005 prioritization) — they
  govern Slices 2/3, not Slice 1. `Verify` stays `none-yet`; targets graduate to `test:` per slice
  as requirement-traced tests land (honest verification — SPECSYS / TEST-2).
- 2026-06-02 — created (draft). **Enrich & Research** (SPEC-0004 Stage 2) modeled as a
  **parallel registry of researchers** (generic core + Web/Code/M365 templates + custom),
  invoked **inline (async `research-request` signal) / scheduled / on-demand**, routed by a
  **deterministic eligibility filter → fan-out → self-nomination**, producing **cited secondary
  sources** that re-enter the pipeline (corroborate→claims, conflict→Review). **Egress gated
  per-researcher by tier**; **BYOA** auth (no stored secrets); **read-only world** (Code
  researcher strictly read-only, isolated worktree); **bounded** (self-moderation + depth-limit
  → Review escalation + global ceiling); **defense-in-depth** untrusted-content posture; a prime
  **Copilot SDK** adopter; managed in a dedicated **Researchers** Control-Panel view. v1 ships
  all three built-ins (incl. M365/WorkIQ via OAuth). Forks resolved with the Principal across a
  12-question walkthrough.
