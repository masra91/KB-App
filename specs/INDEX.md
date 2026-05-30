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

## Reserved / planned (not yet written)

Feature specs, organized by the SPEC-0004 lifecycle stage they belong to. Numbers
assigned at creation time.

| Likely key | Candidate title                  | Type    | Stage     | Notes |
| ---------- | -------------------------------- | ------- | --------- | ----- |
| CAPTURE    | Quick Capture                    | feature | Ingest    | hotkey bar + tray sheet (calls SPEC-0008) — **next** |
| RICHIN     | Rich Ingestion                   | feature | Ingest    | text / drag files / chat (calls SPEC-0008) |
| WATCH      | Folder-Watch Ingestion           | feature | Ingest    | programmatic ingress |
| INTAKE     | Proactive Intake                 | feature | Ingest    | email/news/calendar on schedule (automated) |
| CATALOG    | Decompose & Catalog              | feature | Enrich    | sources → entities/ontology |
| ENRICH     | Enrich & Research                | feature | Enrich    | internal + external context |
| EXPAND     | Connect & Expand (workstreams)   | feature | Enrich    | link prior + raise questions |
| ASK        | Ask / Recall                     | feature | Query     | NL → grounded report |
| EXPLORE    | Explore & Visualization          | feature | Explore   | graphs, timelines, relationship maps |
| REVIEW     | Review & Disambiguation          | feature | Review    | escalations → primary sources |
| REFLECT    | Reflect (self-maintenance)       | feature | Reflect   | stale/emergent/coherence |
| AUDIT      | Audit & Activity                 | feature | Audit     | inspect lineage & activity |
| REPLAY     | Replay & Reprocessing            | feature | Replay    | rebuild from primary + secondary |
| ORCH       | Orchestration & Recurring Tasks  | feature | _x-cut_   | the headless engine |
| PANEL      | Control Panel                    | feature | _x-cut_   | agents/sources/tasks/settings |
| VAULT      | Obsidian Vault Representation    | feature | _x-cut_   | KB as native markdown substrate |

> Numbers are assigned at creation time, in order, to avoid gaps.
