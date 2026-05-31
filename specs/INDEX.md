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
| CONNECT    | Connect & Expand                 | feature | Enrich    | entity resolution / dedup / typed links (promotes Claims' `relatesTo`) — was `EXPAND` |
| ASK        | Ask / Recall                     | feature | Query     | NL → grounded report |
| EXPLORE    | Explore & Visualization          | feature | Explore   | graphs, timelines, relationship maps |
| REVIEW     | Review & Disambiguation          | feature | Review    | escalations → primary sources |
| REFLECT    | Reflect (self-maintenance)       | feature | Reflect   | stale/emergent/coherence |
| AUDIT      | Audit & Activity                 | feature | Audit     | inspect lineage & activity |
| REPLAY     | Replay & Reprocessing            | feature | Replay    | rebuild from primary + secondary |
| PANEL      | Control Panel                    | feature | _x-cut_   | agents/sources/tasks/settings |
| VAULT      | Obsidian Vault Representation    | feature | _x-cut_   | KB as native markdown substrate |

> Numbers are assigned at creation time, in order, to avoid gaps.
