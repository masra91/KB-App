---
spec: SPEC-0003
key: VISION
title: Product Vision & The Core Loop
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0001, SPEC-0002]
supersedes: null
---

# Product Vision & The Core Loop

> A second brain that turns a torrent of fragmented input into grounded, connected,
> recallable knowledge — with effort only at the edges: **quick capture in,
> effortless recall out**, and autonomous agents doing the work in between.

## 1. Intent (the why / JTBD)

The Principal lives a busy life across work, home, personal projects, journals,
scraps of paper, ideas, media, and news — a **torrent of information**. Most of it
is lost, or saved somewhere it will never be found, or saved in a form so
fragmentary and full of private jargon that neither a person nor an LLM nor the
internet could ever make sense of it later.

The job this app is hired for: **be the second brain that catches all of it,
makes it better on its own, and gives it back as grounded knowledge when needed —
without the Principal having to file, organize, or even remember.**

Two felt experiences define success:
- **Quick capture** — sending information of *any* kind to the KB is effortless and
  fire-and-forget.
- **Effortless recall** — asking the KB in natural language returns rich, *grounded*
  answers, full of "what" and "why," traceable to real evidence.

Everything between capture and recall — cataloguing, enrichment, research,
connection, proactive gathering — happens **autonomously**, in the background, by a
team of agents.

## 2. The core loop

```
        ┌──────────────────────────────────────────────────────────────┐
        │                                                              │
   CAPTURE ──► CONTEXTUALIZE ──► DECOMPOSE ──► ENRICH ──► CONNECT ──► (RECALL)
  (any input)   (what is this?)   (entities,    (internal/  (link to      ▲
   fire &       calendar, who,     metadata,     external    prior         │
   forget       transcript)        tags, links)  research,   entities)     │
        ▲                          → ontology     telemetry)     │         │
        │                                                        ▼         │
        │                                              EXPAND (each answer  │
   PROACTIVE INTAKE ◄──────────────────────────────── raises new questions │
   (email, news, calendar pulled in on a schedule)     → workstreams) ──────┘
```

A single fire-and-forget note can spawn a whole **workstream**: agents grab it,
figure out its context, break it into entities, research it inside and out, connect
it to what's already known, and surface new questions to explore — all without the
Principal taking another action. Later, a natural-language question collapses all
of that work into one grounded report.

## 3. Day in the life (the Principal's narrative)

> Preserved as the canonical illustration of the core loop. Specifics are load-
> bearing — they show *why* the magic matters.

At work, the Principal joins a meeting with partner teams to discuss a new project
and timelines. During the meeting they take quick, **fragmented** notes on their
laptop — things to remember, people to check with, actions, key decisions. Very
ordinary — except the notes are fragments full of **domain-specific internal
terminology** that neither an LLM nor the internet has any context on. Leaving the
meeting, they **send the notes to the KB** and head to the next meeting. Fire and
forget.

Later that week it's time to write a proposal for stakeholders. The Principal
**consults the KB** to recall and prepare. The KB returns a **rich report** — not
just of the meeting, but of the surrounding context:

- It reminds them that **two weeks ago** a similar issue came up with a *different*
  customer — with details on who was involved.
- The simple fragments they sent are **gone from the experience**; in their place
  are **full quotes** from the partner teams on what they value and can commit to,
  and the **designs** that were discussed.
- It carries **context and definitions** for the related services on the
  Principal's team, and it **knows the acronyms and jargon** they use internally.
- The report is full of **what and why**, with context — critical grounding data
  for authoring the proposal.
- It even includes **telemetry and BI data** related to the project.

**How did this happen?** In the background, a team of agents:
- grabbed the notes,
- saw the **calendar** and inferred which meeting it was and who attended,
- fetched the **transcript with timestamps**,
- compared against **prior notes** and found last week's records on the related
  topic, connecting the dots,
- searched **internal sources** for definitions and related workstreams,
- searched the **public internet** for prior art,
- **queried databases** for real usage telemetry,
- catalogued, saved, sorted, and understood each piece — each answer raising new
  related questions to explore and expand.

A simple fire-and-forget note created a whole **workstream** that produced grounded,
factual knowledge **without the Principal having to take action.**

## 4. The experience surface (minimal UI)

The actual UX is intentionally light. The app is mostly **headless**.

| Surface | Purpose | Mode |
| ------- | ------- | ---- |
| **Quick-capture bar** | Spotlight-style input bar via global **hotkey** for instant capture | foreground, transient |
| **Tray / menu-bar icon** | System-bar icon opens a **sheet** for quick capture/glance | foreground, transient |
| **Ingestion experience** | Type text, **drag files**, or **interactively chat** to put data in | foreground |
| **Chat / Ask** | Chat-like interface; an agent **queries the KB** in natural language | foreground |
| **Control panel** | Window to **create/manage librarian agents**, **connect data sources**, **set recurring tasks**, settings/config | foreground, occasional |
| **Watched folder** | A monitored/polled folder so **other systems** can add info programmatically | headless ingress |
| **Obsidian vault** | The KB is **natively markdown**; use Obsidian's graph view, bases, etc. directly | external viewer |
| **Headless daemon** | Runs orchestration, recurring jobs, agents, polling continuously with no window | background, always-on |

The defining feel: **quick capture, effortless recall** — the app surfaces only for
those two moments, and otherwise stays out of the way.

## 5. Feature decomposition (the flows inside the loop)

> **Canonical taxonomy lives in [SPEC-0004 KB Lifecycle & Capabilities](SPEC-0004-kb-lifecycle-capabilities.md).**
> The Principal's eight lifecycle stages — **Ingest, Enrich, Query, Explore, Review,
> Reflect, Audit, Replay** — are the backbone feature specs slot under. This section
> keeps only the coarse "in / build / use" intuition; see SPEC-0004 §5 for the
> authoritative stage → feature map (avoids two maps drifting apart).

Coarse lens onto those stages:
- **In** → *Ingest* (Quick Capture, Rich Ingestion, Folder-Watch, Proactive Intake)
- **Build (autonomous)** → *Enrich*, *Reflect* (+ Review feedback), run by Orchestration
- **Use** → *Query* (Ask/Recall), *Explore* (visual)
- **Steward / longevity** → *Review*, *Audit*, *Replay*
- **Cross-cutting** → Orchestration (engine), Control Panel (manage), Vault (substrate)

## 6. Requirements

| ID         | Priority | Statement (short)                                              | Verify   |
| ---------- | -------- | -------------------------------------------------------------- | -------- |
| VISION-1   | must     | Capture is frictionless, multimodal, fire-and-forget           | none-yet |
| VISION-2   | must     | Capture is reachable via quick surfaces (hotkey bar, tray sheet) without opening the full app | none-yet |
| VISION-3   | should   | The KB accepts programmatic ingestion via a monitored folder   | none-yet |
| VISION-4   | must     | Ingested primary sources are preserved immutably even as derived views replace them in the experience | none-yet |
| VISION-5   | must     | Sources are decomposed into entities with metadata, tags, and links (an ontology) | none-yet |
| VISION-6   | must     | Librarian agents enrich entities from internal & external sources, preserving provenance | none-yet |
| VISION-7   | should   | The KB proactively gathers info from connected sources (email, news, calendar) on a schedule | none-yet |
| VISION-8   | should   | Enrichment recursively raises & explores related questions (workstreams), within bounds | none-yet |
| VISION-9   | must     | The Principal can query the KB in natural language and get grounded reports traceable to evidence | none-yet |
| VISION-10  | must     | The app runs headless — orchestration, recurring jobs, polling, agents — with no window open | none-yet |
| VISION-11  | must     | A control panel manages librarian agents, connected data sources, and recurring tasks | none-yet |
| VISION-12  | must     | The KB is natively represented as markdown in an Obsidian-compatible vault | none-yet |
| VISION-13  | must     | The product optimizes for "quick capture, effortless recall" above all | none-yet |

### VISION-4 — Sources immutable, experience derived
- **Status:** draft · **Priority:** must
- **Statement:** Captured **primary sources MUST be preserved immutably**; when
  recall "replaces" the original fragments with a richer view, that replacement
  happens in the **derived/presentation layer only** — the original is never lost.
- **Rationale:** Reconciles the narrative ("the simple notes are gone") with
  Ground Truth is Sacred — *gone from the experience, preserved in storage.*
- **Traces:** PRIN-1, PRIN-9, PRIN-10
- **Verify:** none-yet

### VISION-8 — Bounded autonomous expansion
- **Status:** draft · **Priority:** should
- **Statement:** Agents **SHOULD** recursively spawn follow-up research
  ("workstreams") from new questions, but expansion **MUST** be bounded (scope,
  cost, depth) and steerable by the Principal.
- **Rationale:** The magic ("a note spawned a workstream") is also the risk
  (runaway cost / scope). Boundedness keeps it usable and affordable.
- **Traces:** PRIN-5, PRIN-16
- **Verify:** none-yet

> Remaining VISION-N requirements use the table statement above; each will be
> expanded in its owning feature spec where the detail belongs.

## 7. Open questions

- [ ] **"Notes are gone" vs. immutable sources** — captured in VISION-4 as a
      storage-vs-presentation split. Confirm this is the intended reconciliation.
- [ ] **Autonomy boundaries & approval gates** — agents fetch transcripts, query
      internal databases, search the internet, and pull email *autonomously*. Where
      is that allowed by default vs. gated by Principal approval? (Heavy tie to
      PRIN-19/20 security & least-privilege.)
- [ ] **Connected-source integrations are large & sensitive** — calendar, email,
      meeting transcripts, internal databases, BI/telemetry. Which are in the first
      cut? Each is its own integration + privacy surface.
- [ ] **Domains / contexts** — work vs. home vs. personal vs. journals. One KB with
      scopes/partitions, or multiple KBs? Are there privacy walls between contexts?
- [ ] **Workstream economics** — what bounds recursive expansion (token/$ budget,
      depth limit, priority queue, Principal review)? (VISION-8.)
- [ ] **Obsidian's role** — is the vault the *durable substrate the app reads/writes*
      (Obsidian = optional viewer), confirming markdown as system-of-record? Does the
      app require Obsidian, or merely stay compatible with it?
- [ ] **Recall output shape** — is "a rich report" a generated document, a chat
      answer, a saved entity, or all three? Does recall write back into the KB?

## 8. Changelog

- 2026-05-30 — created (draft). Captured the umbrella vision, day-in-the-life
  narrative, experience surface, feature decomposition, and VISION-1..13.
