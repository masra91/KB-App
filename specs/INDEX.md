# Spec Index

The registry of every living spec. New specs reserve the next `SPEC-NNNN` number
and a unique `key` here.

## Conventions
- **Spec numbers** are sequential and never reused.
- **Keys** are short, uppercase, unique; they namespace requirement IDs (`KEY-N`).
- Keep this table sorted by spec number.

## Specs

| Spec      | Key     | Title                       | Type    | Status | Folder      |
| --------- | ------- | --------------------------- | ------- | ------ | ----------- |
| SPEC-0000 | SPECSYS | The Living Spec System      | meta    | active | `./`        |
| SPEC-0001 | LANG    | Ubiquitous Language (Glossary) | product | draft  | `product/`  |
| SPEC-0002 | PRIN    | Knowledge System Principles | product | draft  | `product/`  |
| SPEC-0003 | VISION  | Product Vision & The Core Loop | product | draft | `product/` |
| SPEC-0004 | LIFE    | KB Lifecycle & Capabilities    | product | draft | `product/` |
| SPEC-0005 | SCOPE   | Contexts, Scopes & Surfacing   | product | draft | `product/` |
| SPEC-0006 | AUTO    | Agent Autonomy & Approval      | product | draft | `product/` |
| SPEC-0007 | DATA    | Core Data Model (Sources/Entities/Outputs) | product | draft | `product/` |
| SPEC-0008 | INGEST  | Ingestion Pipeline (Ingest spine)          | feature | draft | `features/` |
| SPEC-0009 | SETUP   | First-Run / KB Setup (first build story)   | feature | draft | `features/` |
| SPEC-0010 | STACK   | Tech Stack & App Shell Architecture        | architecture | draft | `architecture/` |
| SPEC-0011 | ENG     | Engineering Principles & Rules             | architecture | active | `architecture/` |
| SPEC-0012 | TEST    | Testing Strategy                           | architecture | active | `architecture/` |
| SPEC-0013 | CAPTURE | Simple Capture (v1)                        | feature | draft | `features/` |
| SPEC-0014 | ORCH    | Orchestration & Pipeline Engine            | architecture | draft | `architecture/` |
| SPEC-0015 | DECOMP  | Decompose (Enrich v1)                      | feature | draft | `features/` |
| SPEC-0016 | CLAIMS  | Claims (Enrich v2)                         | feature | draft | `features/` |
| SPEC-0017 | SHELL   | App Navigation Shell                        | architecture | draft | `architecture/` |
| SPEC-0018 | REVIEW  | Review & Disambiguation ("needs you" queue) | feature | draft | `features/` |
| SPEC-0019 | CANON   | Evergreen Canonical & Working-State Isolation | architecture | draft | `architecture/` |
| SPEC-0020 | CONNECT | Connect & Expand (Enrich v3)                | feature | draft | `features/` |
| SPEC-0021 | STAGING | Staging Branch & Promotion Gate             | architecture | draft | `architecture/` |
| SPEC-0022 | REPLAY  | Replay & Reprocessing (full rebuild v1)     | feature | draft | `features/` |
| SPEC-0023 | JOBS    | Autonomous Jobs & Scheduler                 | architecture | draft | `architecture/` |
| SPEC-0024 | REFLECT | Reflect & Rumination (self-maintenance v1)  | feature | draft | `features/` |

## Reserved / planned (not yet written)

Feature specs, organized by the SPEC-0004 lifecycle stage they belong to. Numbers
assigned at creation time.

| Likely key | Candidate title                  | Type    | Stage     | Notes |
| ---------- | -------------------------------- | ------- | --------- | ----- |
| QCAP       | Quick Capture                    | feature | Ingest    | hotkey bar + tray-sheet variant of CAPTURE (SPEC-0013) — calls SPEC-0008 |
| RICHIN     | Rich Ingestion                   | feature | Ingest    | richer text / drag files / chat (extends SPEC-0013; calls SPEC-0008) |
| WATCH      | Folder-Watch Ingestion           | feature | Ingest    | programmatic ingress |
| INTAKE     | Proactive Intake                 | feature | Ingest    | email/news/calendar on schedule (automated) |
| ~~CATALOG~~ | _written → SPEC-0015 (key DECOMP)_ | feature | Enrich  | Decompose (Enrich v1) — entity extraction |
| ~~CLAIMS~~ | _written → SPEC-0016 (key CLAIMS)_ | feature | Enrich  | Claims (Enrich v2) — internal substance about entities |
| RESEARCH   | Enrich & Research                | feature | Enrich    | external corroboration/expansion (egress, AUTO-4; thick agent) — was `ENRICH` |
| ~~CONNECT~~ | _written → SPEC-0020 (key CONNECT)_ | feature | Enrich  | Connect & Expand (Enrich v3) — sole writer of evergreen `entities/` + promotion gate (SPEC-0019 CANON-5) |
| ASK        | Ask / Recall                     | feature | Query     | NL → grounded report |
| EXPLORE    | Explore & Visualization          | feature | Explore   | graphs, timelines, relationship maps |
| ~~REVIEW~~ | _written → SPEC-0018 (key REVIEW)_ | feature | Review  | the "needs you" queue (AUTO-10) — boolean escalations → primary sources |
| ~~REFLECT~~ | _written → SPEC-0024 (key REFLECT)_ | feature | Reflect | Reflect & Rumination — runs on the Autonomous Jobs engine (SPEC-0023, key JOBS) |
| AUDIT      | Audit & Activity                 | feature | Audit     | inspect lineage & activity |
| ~~REPLAY~~ | _written → SPEC-0022 (key REPLAY)_ | feature | Replay  | full rebuild v1; partial/selective replay (LIFE-12/13) still planned |
| PANEL      | Control Panel                    | feature | _x-cut_   | agents/sources/tasks/settings |
| VAULT      | Obsidian Vault Representation    | feature | _x-cut_   | KB as native markdown substrate |

> Numbers are assigned at creation time, in order, to avoid gaps.
