---
design: DESIGN-TERMS
implements: SPEC-0033
title: Terminology Glossary — Canonical User-Facing Vocabulary ("one word per concept")
type: design
status: draft   # Principal-requested root-cause fix for Connect/Linking-type drift; SPEC-0033 gates pending
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-13
updated: 2026-06-28
related: [SPEC-0033, SPEC-0032, SPEC-0048, SPEC-0020, SPEC-0017, SPEC-0050, SPEC-0060]
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector (distinctiveness)
  boundaries: pending       # GATE 2 — KB-QD / KB-QD-2
---

# Terminology Glossary

**Why this exists.** The Principal flagged user-facing vocabulary drift — the same concept
wearing different words across surfaces (the canonical case: the `connect` stage shows as
**CONNECT** on The Line's station signage but **"Linking"** in its volume caption, and a new
Scale-card cap row was about to introduce a third variant). Drift forces the user to re-learn the
same concept per screen and breaks the mental map between the pipeline viz and the controls that
tune it.

This glossary is the **single source of truth for every user-facing string**. It is display-layer
only — it never changes engine ids, stored values, audit actors, wikilinks, or routing (those stay
canonical lowercase, per the `stageLabels.ts` guardrail).

**The rule (SPEC-0033 design-gate bar).** Any net-new user-facing string MUST reuse a canonical
term below, or add one here first via KB-Design-Lead through the design gate. A PR that introduces
a synonym for an existing concept is a gate reject — same class as an unstyled primitive or a
miscoloured state hue.

---

## 0. The product & the Library (Principal-ratified 2026-06-28)

The collection the user builds and owns is their **Library** (instance noun: *your library*).
**Vellum** is the product/app; the **Library** is what it tends — and the inward agents are
**Librarians**, so the word is coherent, warm, and already live (Today: "Your library is quiet and
current"; Health). The acronym **"KB" is BANNED from every user-facing string** — it is internal
jargon and reads as unfinished. Use **Library** in all running UI. The spelled-out **"knowledge
base"** (never "KB") is allowed ONLY as a one-time formal gloss in first-run / help prose. This is
display-layer only: code ids, audit actors, the git repo, wikilinks, and agent codenames keep their
internal names.

| Canonical | Means | Do NOT say |
|---|---|---|
| **Library** | The user's instance — everything Vellum has ingested, connected, and composed for them | **"KB"**, "the KB", "your KB", "vault" (UI; it's the Obsidian/code word), "database", and "knowledge base" in *running* UI (formal one-time gloss only) |
| **Vellum** | The product / app itself | "the app", "the tool", "the system" (in UI chrome) |

**Scrub sites (executor task — change the string AND its asserting test in the same PR):**
- `shell/html.ts` `'My KB'` → **`'My Library'`** (default Library name) + `html.test.ts`, `setupFlow.test.ts`, `settingsView.test.ts`.
- `shell/setupFlow.ts` "…your KB will use the default" → "your library"; "empty, pristine KB" → "empty, pristine library".
- `shell/views/askView.ts` "⚠ not grounded in the KB" → "⚠ not grounded in your library".
- `shell/views/settingsView.ts` "rebuild this KB" → "rebuild your library"; "Scale to KB size" → **"Scale to library size"** (matches §2 Search-depth Auto label).
- `shell/views/jobsView.ts` "reviews your KB" → "reviews your library".
- Prototype `design-prototypes/vellum-v3.html`: "Save to KB" → **"Save to Library"**; Settings card "Knowledge base" → **"Library"**.
- Sweep the rest: `grep -rn "\bKB\b" app/src/shell` and fix every user-facing hit (skip code ids, `KB-*` agent codenames, file paths).

---

## 1. Pipeline stage names

The engine id is canonical for code/vault/audit; the **Display label** is the ONLY string a user
ever sees for that stage. Display labels follow the established action-phrasing pattern (a stage is
named for what it does), never the bare engine id.

| Engine id (canonical, code only) | **Display label (user-facing)** | Do NOT say | Appears on |
|---|---|---|---|
| `decompose` | **Decompose** | "Split", "Break down" | The Line, Scale caps, Activity |
| `claims` | **Claim extraction** | "Claims" (bare id), "Extract" | The Line, Scale caps, Activity |
| `connect` | **Connect** | **"Linking"** (as the stage name), "Link", "Dedup" | The Line, Scale caps, Activity, Reviews |
| `compose` | **Compose** | "Write", "Enrich" (that's a sub-step) | The Line, Scale caps, Activity |
| `archive` / `archivist` | **Archiving** | "Archive" (bare id), "Save", "Store" | The Line, Scale caps, Activity |

**The Connect ruling (the flagged drift).** The stage is **Connect** everywhere a user reads it —
matching the DESIGN-VIZ station signage (`…DECOMPOSE ════▣ CONNECT ─────○ CLAIMS…`), SPEC-0020
("Connect & Expand"), and the engine id `connect`. The verb **"link"** ("Ada Lovelace links to
the Analytical Engine") stays — it names the *relationship the stage produces*, not the stage. So:
the **stage is Connect; its output is links**. "Linking" as a stage name is retired.

> **Concrete drift sites to fix (executor task — not DL's to code):** `stageLabels.ts` currently
> maps `connect: 'Linking'` — change to `'Connect'`; update `stageLabels.test.ts:9`
> (`expect(stageDisplayName('connect')).toBe('Connect')`) and `theLineModel.test.ts:92`
> (`'… reached Connect'`) plus the example comment at `theLineModel.ts:108`. Until this lands, The
> Line renders "Linking" and any new "Connect" label (e.g. the SCALE cap row) will *mismatch* it —
> so the cap row and this one-line label fix must ship together, or the drift just moves.

---

## 2. Concept vocabulary

| Canonical term | Means | Do NOT say |
|---|---|---|
| **Ceiling** | Total concurrency across all stages (`copilotCeiling`); Auto (cores-derived) or Manual | "Max", "Limit", "Parallelism" |
| **Cap** | Per-stage concurrency (Decompose/Claims/Connect/Compose/Archive) | "Stage limit", "Slots" (in prose) |
| **Answer time** | How long recall may work before it returns its best grounded answer so far (`recallBudgetMs`; edited in whole minutes at the UI boundary) | "Timeout", "Budget", "Max time" |
| **Search depth** | How far recall traverses entities/claims/links to gather evidence; Auto ("Scale to library size") or Manual — same grammar as the Ceiling toggle | "Recall budget", "Max tool calls", "Limit" |
| **Search steps** | The per-question retrieval step count set when Search depth is Manual (`recallMaxToolCalls`, 4–24) | "Tool calls", "Iterations", "Max" |
| **Pending** | Work not yet finished at a stage = **queued** + **in-progress** (`pendingForStage`) | "Backlog", "Waiting" (ambiguous) |
| **Queued** | Pending items not yet picked up (the slate segment) | "Waiting", "Pending" (that's the sum) |
| **In-progress** | Items actively draining at a stage (the ember segment) | "Active" in prose (reserve "▣ N active" for the live count glyph) |
| **Effective vs configured** | The ceiling/cap actually in force vs what the user set (they differ under throttling) | "Real", "Actual" |
| **Resolved model / "runs as: ‹x›"** | The model that actually executes after floor/probe/fallback (ORCH-28) | "Active model", "Current model" |
| **Needs your decision** | A user-actionable hold (the brass state) | "Error", "Blocked", "Failed" |
| **Error** | A genuine failure/crash (the oxide state, alarm-only) | "Problem", "Issue" |
| **Throttled / easing off rate limits** | Auto-ceiling self-backing-off a remote 429 (transient, not user-actionable) | "Rate-limited error", "Failed" |

---

## 3. State colour semantics (cross-ref DESIGN-VIZ §3)

Colour carries meaning; a string's hue is part of its vocabulary. Misusing a hue cries wolf.

| Token | Meaning | Use for | NEVER use for |
|---|---|---|---|
| `--viz-ember` | Active heat / live work | in-progress fill, focus rings, the live "actively backing off" dot | settled or idle state |
| `--viz-patina` | Settled / done well | promoted, completed, "all clear" | anything in-flight |
| `--viz-idle` | At rest | queued segment, stations with nothing moving | active work |
| `--viz-brass` | **Needs you / caution** | a user-actionable hold, a config caveat the user must resolve | reassurance, transient self-healing, informational notes |
| `--viz-oxide` | **Broken / alarm** | a real crash/failure only | config warnings, "heavy" hints, throttling |
| `--viz-ink-muted` | Quiet informational | "runs as:", "effective N of M — easing off rate limits", reassuring hints | anything the user must act on |

**Two standing rules baked in here (both from live gate corrections):**
- A **reassuring** note must not wear the **caution** hue — brass on "none starves" is cry-wolf
  (the SCALE `.scale-hint` recolor; the VIZ-10 principle). Reassurance = neutral `--viz-rule` or
  `--viz-ink-muted`.
- **Throttling is informational, not needs-you** — the user can't act on a remote 429, so the
  AIMD throttled-indicator is `--viz-ink-muted`, not brass; oxide is crash-only.

Status markers are **monochrome glyphs, never coloured emoji** (standing voice rule).

---

## 4. Process — adding or changing a term

1. New user-facing concept or a proposed rename → KB-Design-Lead drafts the entry here.
2. Route the change through the SPEC-0033 design gate (gate-1 distinctiveness if it touches the
   visual language, gate-2 boundaries) — same as any design-system change.
3. Executors cite the canonical term in PRs; a gate reviewer rejects any net-new synonym.
4. Renames that flip a *shipped* label (like `connect → Connect`) list their concrete code drift
   sites in the entry so an executor can land the code change in lockstep with the doc.

---

## 5. Surfaces — canonical view names (reconciled with SPEC-0060 v3)

The name in the rail is the ONLY name a user reads for that surface.

| Canonical | What it is | Do NOT say |
|---|---|---|
| **Today** | the home / daily overview | "Dashboard", "Home", "Overview" |
| **Ask** | grounded recall conversation | "Search", "Chat", "Query" |
| **Capture** | quick ingest | "Add", "New", "Inbox", "Import" |
| **Reviews** | the needs-you decision queue | "Tasks", "Approvals", "Inbox" |
| **Explore** | the entity graph | "Graph", "Map", "Browse" |
| **Activity** | the run / audit feed | "Log", "History", "Feed" |
| **Health** | structural lint + remediation | "Diagnostics", "Issues", "Lint" |
| **Agents** | the Manage hub for the workers | "Bots", "Automations", "Workers" |
| **Connectors** | incoming-material feeds (RSS / M365) | **"Sources"** (retired as a surface name — that's the *noun*, §7), "Feeds", "Integrations" |
| **Settings** | global app preferences | "Preferences", "Config", "Options" |
| **Guidance** | the directives surface (SPEC-0050) | "Rules", "Memory", "Instructions" |
| **Manage** | the rail group: Agents / Connectors / Guidance / Settings | "Admin", "Config" |

**Retired surfaces (do not reintroduce):** **Status** / **"The Line"** as a standalone view —
*dissolved* per SPEC-0060 (a slim flow-strip on Today + diagnostics in Health). **Sources** as a
*surface* name → **Connectors**. **Jobs** → folded under Agents as **Schedules**.

---

## 6. The workers — agent role names

| Canonical | Means | Do NOT say |
|---|---|---|
| **Librarians** | the inward, built-in agents that read / connect / maintain your Library (pausable, not removable) | "bots", "workers", "pipeline agents", "jobs" |
| **Researchers** | the outward, egress-gated agents you add that fetch outside corroboration | "crawlers", "scrapers", "web agents" |
| **Schedules** | when recurring Librarian work runs | "Jobs", "Crons", "Tasks" |

---

## 7. Core nouns (the data model, user-facing) — cross-ref SPEC-0001 / SPEC-0007

The display law (one word per concept in UI); precise definitions live in SPEC-0001 LANG.

| Canonical | Means | Do NOT say |
|---|---|---|
| **Source** | a captured piece of evidence (immutable) | "note", "doc", "file", "entry" (a **Connector** is the *intake*; a **Source** is the *thing*) |
| **Entity** | a person / concept / thing the Library knows about | "node", "page", "topic", "record" |
| **Claim** | an atomic statement extracted from a Source | "fact", "statement", "snippet" |
| **Connection** / **link** | a relationship Connect produces between entities | "edge", "relation" (in UI prose) |
| **Output** | a composed, human-readable artifact (e.g. an entity page) | "doc", "report", "summary" |
| **Guidance** (a directive) | a standing human instruction (SPEC-0050) | "rule", "setting", "preference" |

---

## Changelog

- **2026-06-28** — **§0 Library ruling (Principal-ratified):** the user's knowledge base is the
  **Library**; **"KB" is banned from all user-facing strings** ("knowledge base" allowed only as a
  formal first-run gloss). Listed the scrub sites. Folded in the v3 lexicon (SPEC-0060): **§5**
  canonical surface names + retired surfaces (Status/The Line dissolved, Sources→Connectors,
  Jobs→Schedules), **§6** worker roles (Librarians / Researchers / Schedules), **§7** core nouns.
  Updated §2's "Scale to KB size" → "Scale to library size".
- **2026-06-13** — Initial glossary (DESIGN-TERMS). Ratifies **Connect** (not "Linking") as the
  `connect` stage's user-facing name; codifies ceiling/cap/pending/queued/in-progress,
  effective-vs-configured, resolved-model/"runs as", needs-you-vs-error, and the throttling-is-
  informational + reassurance-is-not-caution colour rules. Principal-requested root-cause fix for
  the Connect/Linking drift; lists the `stageLabels.ts` drift sites for an executor.
