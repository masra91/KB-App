---
spec: SPEC-0028
key: RESEARCH
title: Researchers (Enrich & Research — external corroboration & expansion)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-07
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

### 3a. Warm start — orient before egress (RESEARCH-21/22)

A pass does **not** begin cold at the search box. Each eligible researcher first runs a **bounded
orient phase** — *local reads only, no egress* — to spend a little awareness before spending its
query budget:

```
research-request → researcher self-nominates → ORIENT (local, non-egress, own `orientBudget`):
   1. read OWN run history     (the field notebook, RESEARCH-21 — what I've returned, areas I've
                                drilled, sources I've already harvested)
   2. read in-tier KB neighborhood of the subject (EXPLORE read path, SPEC-0039 — what we already know)
   →  produce: the GAP/ANGLE to pursue  +  a DEDUP SET (known facts/sources to skip)
                      │
                      ▼
   EGRESS pass (bounded by `maxToolCalls`): query built via buildOutboundQuery from the request +
   the chosen angle (NEVER a verbatim KB dump, D6a/D8) → fetch NET-NEW sources, expand & enrich
                      │
                      ▼
   write CITED secondary source  +  update the field notebook (areas drilled, sources harvested)
```

The point: a researcher **knows what the KB already holds and what it has already chased**, so each
run *expands the frontier* rather than re-establishing basics or re-finding the same first-page hits.
Awareness is paid for out of a **separate `orientBudget`**, never the egress `maxToolCalls` (D8).

## 4. Built-in templates (v1)

- **Web** — egress tier **`public-web`**. Config: allowed domains/sites, topics, recency
  window, depth. Tools: web search/fetch. *"Get the press release / prior art for X."*
- **Code** — egress tier **`local-only`** (+ GitHub/Azure DevOps **reads** via BYOA). Config:
  repo path, worktree-under-repo (y/n), git-refresh policy, **PR provider** (GitHub *or* Azure
  DevOps), branches/PRs to watch. **Strictly read-only** (RESEARCH-10). **Reasons over the repo via
  the Copilot SDK** — reads relevant files in depth into a cited findings-note, not a grep dump
  (RESEARCH-20). *"Answer questions about this codebase / what changed in these PRs."*
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
| RESEARCH-11| must     | Research is **bounded**: per-researcher **budget** (cost/calls/rate) + a **depth limit** on research→finding→`research-request` chains; the researcher is **prompted to self-moderate** (runaway/drift awareness); on hitting the depth limit it **escalates to Review** ("continue?"); a **global per-Instance ceiling** is the hard backstop. *Each bound is ENFORCED, not advisory (D7).* | test: per-pass calls cap `researchWebAgent.test`(#154); depth→Review-escalation `researchDispatcher.test`+`researchEscalate.test`+`researchInline.test`(chain-depth walk); per-Instance ceiling `researchCeiling.test`+`researchRun.test` | VISION-8; REVIEW; AUTO-12 |
| RESEARCH-12| must     | **Untrusted-content defense**: fetched external content is treated as **data, never instructions**; researchers are prompted/structured accordingly and constrained by egress tier (limits exfiltration), read-only world (limits action), a **per-researcher tool/MCP allowlist**, and budget; findings are **marked externally-sourced** | none-yet | PRIN-19,20; AUTO-6 |
| RESEARCH-13| must     | MCP servers / external tools are **third-party deps** — **vetted, pinned, version-aged** | none-yet | ENG-1,2,4,7 |
| RESEARCH-14| should   | Researchers are a **prime Copilot SDK adopter** (tools/MCP, sessions, ORCH-21/22) — behind the agent interface, deterministic fallback retained | none-yet | ORCH-21,22 |
| RESEARCH-15| must     | Researchers are managed in a **dedicated "Researchers" view** in the Control Panel Manage section: add-from-template, configure (prompt/scope/egress/**budget — an editable per-pass `maxToolCalls`, default 25** + a separate **orient budget** for non-egress awareness reads, RESEARCH-22 + **session timeout**, default 15 min, RESEARCH-18 / MCP), enable/disable, **run-now**, see last-run + findings/citations + escalations. The budget + timeout are **editable controls**, not just the read-only "reach readout" — i.e. the `read-only in v1` readout is **wired to editable inputs** that persist via `setResearcherConfig` (validated at the IPC boundary, under the per-Instance ceiling) | none-yet | PANEL-1; VISION-11 |
| RESEARCH-16| must     | **v1 ships** the framework + three built-in templates — **Web** (public-web), **Code** (local-only, read-only), **M365/WorkIQ** (internal-tenant, OAuth) — plus **custom** | none-yet | VISION-6 |
| RESEARCH-17| must     | A findings-note must be **substantive + structured**, *not* a thin précis: it captures the **specific** facts / figures / dates / named entities / quoted passages the sources actually contain, **each attributed to its source URL**, with real depth — so the secondary source carries genuine substance for Decompose/Claims. *A vague 3-paragraph summary is a defect, not a pass.* The Web skill prompt instructs **depth + specificity** (over brevity); the per-pass retrieval budget **default is 25** (raised 8→15→25) and is **user-editable per researcher** (RESEARCH-15), under the global per-Instance ceiling (RESEARCH-11). Egress posture is unchanged (gated fetch, allowlist, untrusted-content-as-DATA) — more reads + richer capture, same guards | none-yet | RESEARCH-5,6,11,15; PRIN-2; VISION-5 |
| RESEARCH-19| must     | The Researchers view **exposes per-researcher configuration** — a **free-text instructions box** (the agent prompt: *what to look for, which sites/sources, which WorkIQ surfaces, which repo*) **+ scope** — so the Principal can steer each researcher. Templates show **short labels** (`Public Web` · `WorkIQ/M365` · `Local Repository` · `Custom`), long descriptions as helper text | none-yet | PANEL-1; [#109](https://github.com/masra91/KB-App/issues/109) |
| RESEARCH-18| must     | Each researcher has a **per-pass session timeout** — a **stuck-session backstop, NOT a cost bound**. Cost/depth is bounded by the **budget** (`maxToolCalls`) + the per-Instance ceiling (RESEARCH-11); the agent bills **tokens/tools, never wall-clock time**, so a clock cap can only guess at "too long for real work." It exists for one reason: a wedged session would otherwise hold its one **global copilot slot** (ORCH-23) forever and starve the pipeline. **Default 15 min** (the SDK's 60s default false-failed deep multi-fetch passes — `research.session-failed: Timeout after 60000ms waiting for session.idle`); **user-editable per researcher** (RESEARCH-15), passed to the live SDK session. Finite ≠ a deadline for real work | test: `researchSessionTimeout`(wiring) → none-yet (editor) | RESEARCH-11,15,17; ORCH-23 |
| RESEARCH-20| must     | The **Code researcher reasons over the repo via the Copilot SDK** (same `ResearchFn` seam as Web/M365, registered in `selectResearchFn`'s per-template switch — no `makeResearchDeps` change), **not** a deterministic `git grep` dump (today's `researchCodeAgent.ts` shells `git grep` + recent-log + PR-title-match — no model, no SDK, ignores the budget — so the Principal's run (#7) was a literal "code" string-dump, "extremely low effort"). It **reads the relevant files in depth and synthesizes a substantive, source-attributed findings-note** that clears the **RESEARCH-17 depth bar**, with **real repo `path:line` citations** (only files it actually read — fabricated/unread paths rejected, the citation analog of the Web allowlist). **Read-only stays inviolate (RESEARCH-10):** the SDK session's repo tools (read-file / list / grep / log) are thin wrappers over the **read-only `codeGit` layer** in the **isolated, gitignored** worktree — the `availableTools` allow-list admits ONLY those read tools + `submitFindings`; **no** write/exec/network verb is reachable. Fetched repo + PR content is **DATA, never instructions (RESEARCH-12)** (a README/comment saying "ignore your instructions" is quoted content, not a directive). The pass **honors `maxToolCalls`** (read-tool calls counted + refused past budget, forcing convergence — Web's fetch-cap analog) **and the RESEARCH-18 session timeout**; the query is built from the **request (D6a)** via `buildOutboundQuery`, never the template name. A **deterministic fallback is retained (RESEARCH-14)** — SDK-unavailable degrades to today's grep note, never a hard failure. **Slice 1 = local repo**; the gh/az **PR reads stay as-is** (deterministic, CONFIG-pinned) | none-yet | RESEARCH-5,6,10,11,12,14,16,17,18; D6a; AUTO-6 |
| RESEARCH-21| must     | **Warm-start run history ("the researcher's field notebook").** A researcher is **not a cold start** each run: it keeps a **persistent, per-researcher local digest** under `.kb/research/<researcher-id>/` — **derived from its own audit lineage (RESEARCH-6)** — recording **what it has returned** (findings + their citations), the **subjects/areas it has already drilled** (with last-touched timestamps so a stale area re-opens), and the **sources/domains it has already harvested**. It is a **derived index, not a second source of truth** — the audit is canonical; the digest is the cheap working set, rebuilt from it — and **bounded + self-healing** (rolling cap, stale entries age out; mirrors `seen.json`/`passes.json`). The researcher **reads it at the start of a pass** (the orient phase, RESEARCH-22). *This piece reintroduces no exfiltration surface — a researcher reading its OWN prior outputs/citations — so it ships independent of the D6 egress mapping (D8).* | none-yet | RESEARCH-5,6,11; AUDIT-11; DATA-10 |
| RESEARCH-22| must     | **Orient-before-egress (expand & enrich, don't re-find the first hits).** Before any outbound query, a researcher runs a **bounded orientation** that reads (a) its own **run history** (RESEARCH-21) and (b) the **in-tier** KB neighborhood of the request's subject (via the **EXPLORE** entity-neighborhood read path, SPEC-0039), gated by **one tier↔sensitivity check for all researchers** (`sensitivityAllowsOrientRead`, D8) — a **tier-agnostic structural floor** (neighbor entity names) for every researcher now + **sensitivity-gated content reads** that **auto-light when SPEC-0005 classification lands**, no per-template carve-out — producing the **specific gap/angle to pursue** + a **dedup set** of already-known facts/sources to avoid repeating, so the pass **expands and enriches** instead of re-fetching the same first-page hits. Orient reads are **KB-/audit-LOCAL (non-egress)** and therefore do **NOT** consume the egress `maxToolCalls`; they are bounded by a **separate, small `orientBudget`** (default modest, user-editable per researcher, RESEARCH-15) so awareness can't run away. **The egress invariant holds (D6a/D8):** orientation chooses a *target/angle + dedup set* — the **outbound query is still built through the constrained `buildOutboundQuery` path** (request + chosen angle, **never a verbatim KB dump**); result-level dedup steers toward **net-new sources**. Tier-gated read + query-construction guard are the **gate-2 security boundary** (D8) | none-yet | RESEARCH-6,8,11,17,21; SCOPE-7,8,9,10; SPEC-0039; D6; D6a; D8; VISION-8 |
| RESEARCH-23| must     | **Full lifecycle: delete + complete the editable surface (PANEL-11).** (a) **Delete** — a researcher can be **removed** from the Researchers view (confirm-gated): `removeResearcher` purges the registry entry + tears down scheduled passes + audits the removal; **past findings (secondary sources) + audit are RETAINED**. (b) **Editable fields** — the view exposes the researcher's **`label`** (friendly display name) and **`topics`** (eligibility pre-filter) as editable inputs — both already accepted by `patchResearcher`/`setActiveResearcherConfig`, just not surfaced. (`maxDepth` / `allowedTools` stay read-only — safety/security surface, by design.) *Today a researcher cannot be deleted at ANY layer (no registry/IPC/view op) — the systemic delete gap.* | none-yet | PANEL-11; RESEARCH-15; DATA-2; AUDIT-11 |

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
  RESEARCH-10) — its own PR + security review. *(Slice 2a/2b shipped the deterministic read pass —
  grep + log + gh/az PR title-match. **WS4 / RESEARCH-20** upgrades the local-repo read to **agentic
  SDK reasoning** behind the same seam; gh/az PR reads stay as-is.)*
- **Slice 3 — M365/WorkIQ** (`internal-tenant`, OAuth MCP) + **custom** researcher polish.
- **Slice 4 — Warm-start orientation (RESEARCH-21/22).** The field notebook + orient-before-egress phase
  + the `sensitivityAllowsOrientRead` gate (D8). Lands behind the existing `ResearchFn` seam — the orient
  step runs *before* `runResearcher`'s egress pass and feeds it a target/angle + dedup set. **Gate-2
  (KB-QD) reviews the query-construction guard + the sensitivity gate before it merges.** Ships against the
  conservative-default gate (no dependency on SPEC-0043 being done); richer public-web reads light up when
  SPEC-0043 (SENSE) classification lands. *Sub-slices: 4a = field notebook (RESEARCH-21, derived from
  audit) + result-level source dedup; 4b = orient phase + structural-floor KB read + `orientBudget`;
  4c = sensitivity-gated content reads wired to SENSE-3 comparator.*

## 7b. Warm-start handoff — data shapes, config, user stories (RESEARCH-21/22)

**Field-notebook digest** (`.kb/research/<researcher-id>/notebook.json`) — derived from the researcher's
own audit lineage (RESEARCH-6), bounded + self-healing (rolling cap, stale ages out; mirrors
`seen.json`/`passes.json`):

```jsonc
{
  "researcherId": "web-1",
  "areas": [            // subjects/topics already drilled — re-opens when stale
    { "key": "quantum-error-correction::entity-xyz", "lastRunTs": 1717800000000,
      "returned": "finding", "citations": 3 }
  ],
  "harvested": [        // sources already fetched+cited → result-level dedup (don't re-find page 1)
    { "host": "arxiv.org", "url": "https://arxiv.org/abs/…", "ts": 1717800000000 }
  ],
  "frontier": [         // expand-next: entities a finding mentioned but did NOT cover
    { "term": "surface codes", "fromSourceId": "src-…", "ts": 1717800000000 }
  ]
}
```

**Config** — `orientBudget` joins the editable per-researcher controls (RESEARCH-15) alongside
`maxToolCalls` + `timeoutMs`: a small cap on **local (non-egress)** orient reads (default ~5, user-editable,
validated/clamped at the IPC boundary like `maxToolCalls`). It is **separate from `maxToolCalls`** — orient
reads never draw down the egress budget (Principal: "don't burn query budget maintaining awareness").

**The gate** — `sensitivityAllowsOrientRead(tier, sensitivity): boolean` reads the **SENSE-3 comparator**
(SPEC-0043) against the **D6 map**: `public-web → rank ≤ shareable`, `internal-tenant → ≤ confidential`,
`local-only → any`. The **structural floor** (neighbor entity names) is tier-agnostic and bypasses the
content gate (graph metadata, not content). Until SPEC-0043 lands, all sources read `internal` → public-web
sits on the floor; internal-tenant/local-only read in-tier.

**User stories:**
- **As a researcher**, before I search I read my own notebook + the subject's KB neighborhood, so I chase
  the **gap** ("we have the press release but not the benchmark numbers") instead of re-fetching the
  overview I already filed last run. *(RESEARCH-21/22)*
- **As the Principal**, my Web researcher stops handing me the same three first-page links every run — its
  notebook remembers what it harvested, so each pass brings **net-new** sources. *(RESEARCH-21)*
- **As the Principal**, I can see "areas drilled" + "last run" per researcher and trust that awareness is
  cheap — it runs on a separate `orientBudget`, never eating the egress budget I set. *(RESEARCH-22)*

**Verify targets (graduate `none-yet → test:` per sub-slice):** notebook round-trip + bounded/self-healing
(`researchNotebook.test`); orient produces a gap/angle + dedup set from notebook+neighborhood
(`researchOrient.test`); `orientBudget` clamp at the IPC boundary (`researchers.test`); orient reads do NOT
increment the egress fetch counter (`researchRun.test`); `sensitivityAllowsOrientRead` per-tier truth table
+ structural-floor bypass (`researchSensitivityGate.test`); query-construction guard rejects a raw-KB-dump
query (`researchOrient.test`).

## 8. Resolved decisions (Slice 1 locked) + escalations

Forks resolved with KB-PM (D1–D3, D5, D6a are KB-PM/owner calls; D4-policy remains
**escalated to the Principal**; **D6 — the egress-tier↔sensitivity mapping — is now RESOLVED by the
Principal**, 2026-06-07, see below):

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
- **D6 — egress-tier ↔ sensitivity mapping: RESOLVED (Principal, 2026-06-07).** The ratified table —
  the **policy table the orient gate (D8) and any future egress-content feeding read**:
  - `public-web` → may read **`shareable`** only
  - `internal-tenant` → may read **up to `internal` / `confidential`** (the user's own tenant)
  - `local-only` → may read **any** sensitivity (incl. `confidential`; stays on the local machine)

  Sensitivity labels are **already specced** in **SPEC-0005 (SCOPE-7/8/9/10)** — `shareable` /
  `internal` / `confidential`, default-`internal`-on-capture, applied at ingestion, propagated
  most-restrictively. They are **not yet implemented**, so today every source reads as `internal` and the
  mapping yields the conservative default (public-web reads no content — only the D8 structural floor —
  while internal-tenant/local-only read in-tier). **Implementing SPEC-0005 SCOPE-7/8/9 is the prioritized
  work that "lights up" richer public-web reads** through this same mapping — no new researcher code path.
  This governs both the orient KB-read (RESEARCH-22) and the broader Slice-2/3 egress-content relaxation.
- **D7 — RESEARCH-11 bounds: enforcement model** (KB-PM-ratified, forks brought by KB-Developer-5):
  every bound is **deterministically ENFORCED at a chokepoint, never prompt-advisory** (the
  self-moderation prompt is a hint *on top of*, not instead of, the hard gate).
  - **Per-pass calls budget** — the live SDK session counts `fetch` tool calls and refuses past
    `budget.maxToolCalls`, forcing convergence to `submitFindings` (shipped #154/#165; mirrors recall #113).
    *cost/rate*: **rate** is satisfied by the scheduler cadence + the dedup ledger (D2); **cost** is
    subsumed by the calls cap in v1 — **no token meter** is built (a deliberate non-goal until a real
    need; revisit if cost diverges from calls).
  - **Depth limit** — each `research-request` carries a `depth` computed centrally from the audit
    lineage (research→finding→`research-request` hops) in `collectResearchRequests`; the **dispatcher**
    (sole router) refuses to run a pass when `depth > budget.maxDepth` (no egress).
  - **Escalate-to-Review** — at the depth limit the dispatcher raises a single gated yes/no Review
    ("Continue researching X?"), idempotent per request, audited `escalated`. **Raising + gating the
    chain IS the RESEARCH-11 bound.** Because that Review is an **actionable** control (it renders in
    the Reviews view with confirm/reject), *resume-on-confirm* was delivered as the immediate fast-follow
    so the affordance isn't dead: on **confirm**, `resumeApprovedResearchEscalation` reconstructs the
    request from the review's markerKey and re-runs `runResearcher` exactly one level deeper (a direct
    call bypasses the dispatcher's depth gate by design, still bounded by the per-Instance ceiling); on
    **reject**, the chain stops. A finding that spawns a yet-deeper request re-escalates — so every level
    stays Principal-gated.
  - **Global per-Instance ceiling** — a **persistent rolling-window** cap (default **100 passes / 24h**,
    **tunable**) on total passes (egress) across all researchers, layered on the per-dispatch burst cap
    (24). Enforced at `runResearcher` so it bounds inline dispatch **and** scheduled standing passes; a
    **safety backstop, not a normal-use limit**, and **self-healing** (passes age out of the window).
    Purely a runaway/volume backstop — *not* the egress↔sensitivity policy (that's the D6 mapping, now resolved).
- **D8 — orient/awareness boundary (the warm-start carve-out to D6a; KB-Lead, reads the now-resolved D6 mapping):**
  the strict D6a floor ("the Web researcher never reads KB content") is **narrowed, not removed** so
  researchers can warm-start (RESEARCH-21/22) without reopening the exfiltration hole D6a closed. The rule:
  - **Query-construction invariant preserved.** KB/audit content MAY inform **target selection + dedup**
    during the bounded orient phase, but the **outbound query is still built via `buildOutboundQuery`**
    (request + a model-chosen *angle*) — **never KB content verbatim**. A guard rejects a raw-KB-dump
    query. *Orientation chooses WHAT to chase; it never becomes the egress string.*
  - **Past-run awareness (RESEARCH-21) ships unconditionally** — a researcher reading **its own** prior
    findings/citations/harvested-sources adds no exfiltration surface (its outputs are already
    externally-sourced or its own notes), so it is independent of the D6 mapping.
  - **KB-state awareness (RESEARCH-22b) is governed by ONE tier↔sensitivity gate for ALL researchers —
    not a per-template carve-out — wired against the live classification from day one.** The orient
    KB-read obeys RESEARCH-8 (content only at-or-below the researcher's tier) via a single
    `sensitivityAllowsOrientRead(tier, sourceSensitivity)` check. Two layers:
    - **Structural floor (tier-agnostic, always available):** the subject + its direct-neighbor **entity
      names/labels** are graph **metadata, not content**, so every researcher — public-web included — gets
      this much warm-start *now* (enough to dedup "which entities do we already cover" and steer to gaps).
    - **Content reads (sensitivity-gated, auto-lighting):** note bodies / claim text are admitted only when
      the gate passes. Because sensitivity is **hardcoded `internal`** today (no SPEC-0005), the gate is
      **conservatively scoped by default** — internal-tenant / local-only read in-tier content now;
      public-web falls back to the structural floor. **When SPEC-0005 (SCOPE-7/8/9) classification is
      implemented and sources carry real labels, the SAME gate automatically admits the now-`shareable`
      content to public-web (etc.) — it "just lights up" for research, no new code path.** The gate's
      **policy table is the now-RESOLVED D6 mapping** (public-web→shareable, internal-tenant→internal/
      confidential, local-only→any) applied to the **SPEC-0005 SCOPE-7 labels** — one table, read by both
      the orient gate and any future egress-content feeding.
  - **Budget separation.** Orient reads are non-egress and draw on a **separate `orientBudget`**, never
    the egress `maxToolCalls` — awareness is cheap and bounded, and never starves the actual research.
  - **Gate-2 (KB-QD) reviews** the query-construction guard + the public-web read-limit as the
    load-bearing security boundary before RESEARCH-22 implementation lands.

### RESEARCH-20 (WS4) — forks: **RESOLVED (KB-Lead, 2026-06-06)**

Both forks were brought with recommendations by KB-Developer-5 and **ratified by KB-Lead** (PR #219 product review). Locked below; implementation follows the ratified posture.

- **D-WS4-a — grep pre-filter vs. fully agentic. → RESOLVED: hybrid (cheap `git grep` SEED + agent-directed depth), not fully-agentic-from-scratch.** The existing `git grep` + recent-log becomes a **deterministic seed** that focuses the SDK session (the hit-file set + matched lines are handed to the agent as a starting map); the agent then **reads those + follows its own reasoning** — opening related files, issuing further reads/greps through the read-only layer — to synthesize the depth-bar note. The agent is **"seeded, not caged"** — it may read beyond the seed (so a thin-grep topic still gets reasoned over), with `maxToolCalls` + the per-Instance ceiling as the hard backstops. Rationale: (1) bounds the search space in a large repo → fewer tool calls, faster convergence under `maxToolCalls`; (2) mirrors the **Web posture** ("search broadly, then read several sources in depth") — grep is Code's *search*, agentic file-reading is the *depth*; (3) **preserves the RESEARCH-14 deterministic fallback for free** — the seed IS today's grep note, so an SDK-unavailable env degrades to it gracefully; (4) avoids unbounded directory walks. *Fully-agentic-from-scratch* (no seed) is rejected for v1: it burns budget re-discovering what grep finds in one call and loses the cheap fallback.
- **D-WS4-b — bounding a large repo. → RESOLVED: a deterministic candidate-set guard fed to the agent, with `maxToolCalls` as the hard read-budget backstop; caps enforced in the read layer (not the prompt).** **v1 defaults (KB-Lead-ratified, tunable, NOT a Slice-1 blocker — Principal can retune; the *mechanism* is what RESEARCH-20 asserts):** the session may open at most **≤ 40 candidate files**, **≤ 256 KB read per file** (truncate-with-marker beyond), with a **path ignore-set** skipping `.git/`, `node_modules/`, `dist/`/`build/` artifacts, lockfiles, and binary/generated blobs. **The candidate frontier is relevance-ORDERED (KB-Lead add):** grep-hit files first, then their imports/neighbors — so within `maxToolCalls` the agent reads the *most relevant* files, not the first 40 alphabetically. The read tools enforce the per-file byte cap + ignore-set + ordering deterministically (the agent can't escape them); `maxToolCalls` caps the number of reads; the per-Instance ceiling (RESEARCH-11) caps passes. Rationale: keeps egress/compute bounded **and** convergent without the agent drowning in a monorepo, while the hard caps live in the read layer.

## 9. Changelog

- 2026-06-07 — **D6 RESOLVED — egress-tier↔sensitivity mapping ratified** (Principal). The long-escalated
  mapping is locked: `public-web → shareable`, `internal-tenant → up to internal/confidential`,
  `local-only → any`. This is the **policy table** the RESEARCH-22 orient gate (D8) and any future
  egress-content feeding read. Clarification captured the same turn: **SPEC-0005 already exists and specs
  the sensitivity model** (SCOPE-7/8/9/10 — labels, default-`internal`-on-capture, ingestion-time
  classification, most-restrictive propagation); it is **not yet implemented**, so today all sources read
  `internal` and the mapping yields the conservative default. **Implementing SCOPE-7/8/9 is the prioritized
  parallel track** that lights up richer public-web orient reads through this same mapping — *not* new spec
  authoring (the earlier "draft SPEC-0005" framing was a misread; the spec is in `specs/product/`).
- 2026-06-07 — **RESEARCH-21/22: warm-start orientation — researchers are KB- & past-run-aware, not
  cold-start** (Principal). Today every pass starts cold: the researcher reads neither the KB nor its own
  history, builds one outbound query from the request string, and re-finds the same first-page hits run
  after run (the only persistent state is the request-level dedup `seen.json` + the ceiling `passes.json`
  — neither a working memory). Two new `must` requirements close that: **RESEARCH-21** — a **persistent
  per-researcher "field notebook"** under `.kb/research/<id>/`, **derived from its own audit lineage**,
  recording what it returned (findings + citations), the subjects/areas it has drilled (timestamped, stale
  re-opens), and the sources/domains harvested (a **derived index**, not a second truth; bounded +
  self-healing). **RESEARCH-22** — an **orient phase before egress**: bounded **local (non-egress)** reads
  of (a) the field notebook and (b) the **in-tier** KB neighborhood (EXPLORE read path, SPEC-0039) produce
  a **gap/angle + dedup set** so the pass **expands & enriches** toward **net-new** sources instead of
  re-finding basics. **Awareness is paid from a separate `orientBudget`**, never the egress `maxToolCalls`
  (Principal ask: "don't burn query budget maintaining awareness"). **Egress invariant preserved (new
  decision D8 narrows D6a):** orientation chooses a target/angle — the outbound query is still built via
  `buildOutboundQuery` (request + angle, never a verbatim KB dump). The KB-state read is governed by **one
  tier↔sensitivity gate for ALL researchers** (`sensitivityAllowsOrientRead`, D8), **not a per-template
  carve-out** (Principal: "don't scope this to just web — make it work for all using the sensitivity"): a
  **tier-agnostic structural floor** (neighbor entity names) gives every researcher warm-start now, and
  **sensitivity-gated content reads auto-light when SPEC-0005 classification lands** ("just lights up for
  research, no new code path"). Because sensitivity is hardcoded `internal` today, the gate is
  **conservatively scoped by default** (internal-tenant / local-only read in-tier content now; public-web
  sits on the structural floor) — so **RESEARCH-21/22 do NOT block on SPEC-0005**; implementing SPEC-0005
  SCOPE-7/8/9 classification is the prioritized parallel work that *unlocks* richer public-web reads
  through the **now-resolved D6 mapping** this gate reads. **Past-run awareness (RESEARCH-21)
  ships unconditionally** (own outputs, no exfil surface). **Gate-2 (KB-QD)** reviews the
  query-construction guard + the sensitivity gate as the load-bearing boundary. Also: **per-pass `maxToolCalls` default raised 15 → 25** (the warm start spends
  egress on expansion, not basics; the Principal had flagged pushing it past 15) — `researchers.ts:54`,
  registry-default + code-skill tests updated, RESEARCH-15/17 text refreshed. **Spec-only — no
  implementation until this lands + clears gate-2** (the orient/egress boundary is security-load-bearing).
- 2026-06-06 — **RESEARCH-20: Code researcher grep → agentic (WS4)** (Principal app-review #7 — the Code
  researcher's run was a literal "code" string-dump, "extremely low effort"; KB-Lead root-caused it as a
  deterministic `git grep` with no model/SDK/budget). New requirement: the Code researcher must **reason
  over the repo via the Copilot SDK** behind the same `ResearchFn` seam as Web/M365 — read relevant files
  in depth and synthesize a **substantive, source-attributed findings-note** (RESEARCH-17 depth bar) with
  **real `path:line` citations**, honoring `maxToolCalls` + the RESEARCH-18 timeout, with the **RESEARCH-10
  read-only invariants intact** (read-only `codeGit` layer + isolated gitignored worktree + read-only
  `availableTools` allow-list), repo content framed as **DATA (RESEARCH-12)**, query from the **request
  (D6a)**, and a **deterministic grep fallback retained (RESEARCH-14)**. **Slice 1 = local repo**; gh/az PR
  reads stay as-is. The degenerate "code" outbound query was already fixed in WS1 #6 (`researchWhatFor` →
  real name, not the template word). **Both forks RATIFIED by KB-Lead (§8 D-WS4-a/b, PR #219 product
  review):** (a) hybrid grep-SEED + agent-directed depth ("seeded, not caged"), not fully-agentic; (b)
  deterministic candidate-set guard with `maxToolCalls` as the hard backstop — v1 defaults **≤ 40 files ·
  ≤ 256 KB/file · ignore-set** (`.git`/`node_modules`/`dist`/`build`/lockfiles/binaries), frontier
  **relevance-ordered** (grep-hit files first, then imports/neighbors; KB-Lead add), caps enforced in the
  read layer (tunable, not a Slice-1 blocker). **Spec-only — no implementation until this lands + is
  reviewed** (KB-Lead product ✓ + KB-QD-2 spec gate-2).
- 2026-06-04 — **RESEARCH-18: session timeout is a stuck-backstop, not a budget — and both it + the
  budget are user-editable** (Principal, from a live `Run now` failure: `research.session-failed:
  Timeout after 60000ms waiting for session.idle`). Root cause: the live SDK sessions used the Copilot
  SDK's **60s `sendAndWait` default**, which the #209 budget bump (8 → 15 deep reads) routinely
  exceeds. **Ruling (Principal):** the agent bills **tokens/tools, not time**, so a clock timeout is the
  wrong cost control — it's only a backstop to recover a *wedged* session (and its held global copilot
  slot, ORCH-23). Make it **generous (default 15 min)** and **user-editable per researcher**, alongside
  the **budget**, which must also become a real editable control (today the view shows budget *read-only*
  — RESEARCH-15 was specced as editable but never wired). **Interim shipped (#213):** fixed 15-min
  default passed to both live tiers (web + M365) + regression test, to stop the false-fails now. **Still
  open:** persist a per-researcher `timeoutMs` (+ wire the editable budget/timeout controls).
- 2026-06-03 — **RESEARCH-17: substantive researcher output + user-editable budget** (Principal —
  live-test observation that researchers returned a thin ~3-paragraph summary + links). The findings-note
  must now be **substantive/structured** (specific facts/figures/dates/quotes, each source-attributed,
  with depth) — the thin précis was the *skill prompt's* doing (it asked for a "short, brief note"), so the
  fix is the prompt + output shape, not just budget. **Per-pass `maxToolCalls` default raised 8 → 15** and
  made **user-editable per researcher** in the Manage view (RESEARCH-15); the Principal expects to push it
  higher. Egress guards unchanged (gated fetch, allowlist, untrusted-content-as-DATA, global ceiling).
- 2026-06-02 — **RESEARCH-11 fully discharged — all bounds enforced** (KB-PM-greenlit; KB-Developer-5).
  Completed the residual clauses after the per-pass calls cap (#154/#165): a **depth limit** on
  research→finding→`research-request` chains (computed from audit lineage, enforced at the dispatcher),
  **escalate-to-Review** at the limit (a gated "continue?" Review, idempotent per request), and the
  **global per-Instance egress ceiling** (a persistent rolling-window backstop, 100 passes/24h tunable,
  enforced at `runResearcher` so it bounds inline + standing passes alike, self-healing). All bounds are
  deterministically enforced, never prompt-advisory (decision **D7**). Forks (ceiling semantics =
  persistent rolling-window; escalation = raise+gate; cost/rate = cadence + calls, no token meter) were
  brought to + ratified by KB-PM. `Verify` graduates `none-yet → test:` (researchDispatcher /
  researchEscalate / researchCeiling / researchInline / researchRun / researchWebAgent). New `escalated`
  + `ceiling-reached` researcher audit events (AUDIT-11).
- 2026-06-02 — **Resume-on-confirm delivered** (RESEARCH-11 fast-follow; KB-PM-ruled). The depth-escalation
  Review is an actionable control, so a confirmed "Continue researching X?" now actually continues:
  `resumeApprovedResearchEscalation` reconstructs the request from the review markerKey + re-runs one
  level deeper (`researchResume.ts`), wired into `answerActiveReview` (self-gating, like the consolidation
  resume). Reject stops the chain; deeper findings re-escalate (every level Principal-gated). Tested
  confirm/reject/unanswered/non-research (`researchResume.test`).
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
