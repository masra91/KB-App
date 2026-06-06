---
spec: SPEC-0037
key: WATCH
title: Folder-Watch Ingestion (programmatic ingress)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0004, SPEC-0006, SPEC-0007, SPEC-0008, SPEC-0027, SPEC-0034]
stage: Ingest
supersedes: null
---

# Folder-Watch Ingestion (programmatic ingress)

> A **hands-off ingress**: the Principal points the KB at one or more **watched folders**;
> anything that lands there is ingested automatically — no app, no paste, no click. It is a
> **connector onto the INGEST spine** (SPEC-0008), not a second pipeline: a file appears →
> the spine preserves it immutably, classifies, catalogs, and hands off to Enrich, exactly
> as any other arrival. *"Drop a PDF in my `KB-Inbox` folder and it just shows up, enriched."*

## 1. Intent (the why / JTBD)

Capture today (SPEC-0013) is **pull**: the Principal opens the app and pastes/drops. The
day-in-the-life wants **push** too — a folder the OS, a scanner, a `Save to…`, a script, or
another app can drop into, with the KB folding it in unattended. This is the lowest-friction,
most-automatable ingress and the reusable **"programmatic ingress" pattern** the other Ingest
features (Rich Ingestion, Proactive Intake) build on. WATCH owns *detection + delivery*; every
preservation/classification guarantee comes from the INGEST spine it calls — WATCH never
re-implements the pipeline.

## 2. Scope

**In:** detecting files in Principal-configured local folders; delivering each as an arrival to
INGEST (SPEC-0008) with watch provenance; idempotency, debounce, restart reconciliation, bounds,
and the manage surface to configure folders.
**Out (deferred, separate specs):** the in-app Quick Capture hotkey/tray surface (QCAP); rich
in-app composition (RICHIN); scheduled *outbound* pulls — email/news/calendar (INTAKE, which is
*proactive fetch*, not *folder watch*); cloud-drive/remote watching beyond a local mounted path.

## 3. The flow

```
Principal configures a watched folder  (e.g. ~/KB-Inbox)
        │
        ▼
file appears / changes  →  WATCHER debounces until the file is STABLE (not mid-write)
        │                         │ ignored glob / oversize / loop-path → skip + log (never silent)
        │                         │ already-ingested (contentHash) → skip
        ▼                         ▼
   deliver to INGEST (SPEC-0008): preserve immutably → classify (scope/sensitivity)
        │                          → catalog → enqueue Enrich     [provenance surface = watch:<folder-id>]
        ▼
   the user's ORIGINAL file is untouched (copied in, never moved/deleted) — AUTO-6
```

On startup (or after downtime) the watcher **reconciles**: it scans each folder against
already-ingested sources, ingesting what it missed while down and skipping what it already has.

## 4. Requirements

| ID       | Priority | Statement (short) | Verify | Traces |
| -------- | -------- | ----------------- | ------ | ------ |
| WATCH-1  | must     | WATCH is a **connector onto the INGEST spine** (SPEC-0008), not a parallel pipeline: a detected file is delivered as an arrival and the spine owns preserve→classify→catalog→enqueue. Provenance records `surface = watch:<folder-id>` + the absolute origin path + detection time (INGEST-3) | none-yet | INGEST-1,3; LIFE-1 |
| WATCH-2  | must     | A file is ingested only once it is **stable** — the watcher waits for size/mtime to quiesce (settle window) so a partial/still-copying/still-downloading file is **never ingested mid-write**; create + move-in + content-modify all trigger | none-yet | PRIN-1; INGEST-2 |
| WATCH-3  | must     | **Idempotent**: the same content is not re-ingested — dedup by `contentHash` (DATA), so a re-save, an editor's atomic-rename, or a duplicate event yields no duplicate source. A **changed** file follows the data-model version rule (see open-q #1) | none-yet | DATA-2; INGEST-2 |
| WATCH-4  | must     | **Non-destructive** (read-only world, AUTO-6): the watcher **copies** content into the KB and **never moves, deletes, or modifies** the watched original. (An opt-in "consume/move-out" inbox mode is deferred — open-q #2) | none-yet | AUTO-6; PRIN-1 |
| WATCH-5  | must     | **Restart-safe reconciliation**: on startup/after downtime the watcher reconciles each folder against already-ingested sources — files that appeared while it was down are still ingested (no missed-event loss), already-ingested files are skipped (no re-ingest) | none-yet | PRIN-1; INGEST-8 |
| WATCH-6  | must     | **No-loop / no-pollution**: the watcher refuses to watch the KB vault itself, its `.kb/`/`.git`/`.obsidian` internals, or any path that would re-ingest KB-produced files — so promotion/Enrich writes can never feed back as new arrivals | none-yet | CANON; PRIN-1 |
| WATCH-7  | must     | **Bounded + guarded**: ignore globs (dotfiles, `*.part`/`*.crdownload`/`*.tmp`, editor swap files), a max file size, and a per-window ingest cap so a bulk dump or runaway can't flood the pipeline; an ignored/oversize/unsupported file is **skipped with a logged reason** (OBS), never silently dropped | none-yet | PRIN-1; LIFE-6 |
| WATCH-8  | must     | **Durability inherited**: a classify/catalog failure leaves the file **preserved + flagged** (not lost), and a watcher crash mid-deliver neither double-ingests (WATCH-3 dedup) nor drops it (WATCH-5 reconcile) | none-yet | PRIN-1; INGEST-8,9 |
| WATCH-9  | should   | **Managed in the Control Panel → Sources** (SPEC-0027 PANEL): add/remove watched folders, enable/disable, see per-folder last-ingested + counts + any skipped-with-reason. The folder list is an editable surface (built on the WS2 design-system controls) | none-yet | PANEL-1 |
| WATCH-10 | should   | **macOS file access**: a watched folder outside the app's granted scope triggers the SPEC-0034 folder-permission flow before watching begins; denied → the folder reads as `needs permission`, not a silent no-op | none-yet | MACOS-7 |
| WATCH-11 | must     | Accepts the **same input kinds as INGEST** (INGEST-7: text/markdown/PDF/URL-file/…); an unsupported kind is a skip-with-reason (WATCH-7), not a crash and not a malformed source | none-yet | INGEST-7 |

## 5. Open questions (forks) — RESOLVED (KB-Lead, 2026-06-07)

1. **Edit semantics → RATIFIED: a changed watched file is a NEW immutable source, provenance-linked to the prior** (not an in-place version). A watched file is an external artifact, not a KB-owned doc we edit in place; new-source-with-link is the only resolution consistent with DATA immutability (SPEC-0007). The dedup in WATCH-3 keys on `contentHash`, so an *unchanged* re-save is a no-op while a *changed* file ingests as a new source carrying a `derivedFrom`/prior-source provenance link.
2. **Consume mode → RATIFIED: default stays non-destructive copy (WATCH-4); the opt-in "move-out after ingest" is Slice 2.** No change to v1.
3. **Recursion / symlinks → RATIFIED for v1: watch the configured folder NON-RECURSIVELY and DO NOT follow symlinks** (a symlink could resolve outside the granted macOS scope — security; WATCH-6/WATCH-10). Recursive watch (with a depth cap) is Slice 2.
4. **Engine → RATIFIED: use a vetted cross-platform watcher (`chokidar`), pinned + ≥7-day per E1** — `fs.watch` is unreliable for stable-file detection across platforms. Exact version pinned at build time under the E1 supply-chain rule.

## 6. Slices

- **Slice 1 (v1):** one or more watched folders; stable-file detection; copy→INGEST with watch provenance; contentHash dedup; restart reconcile; bounds + ignore globs; loop-guard; non-recursive + no-symlink-follow (forks #1/#3/#4 resolved above); Sources-view add/remove.
- **Slice 2:** consume/move mode (fork #2); recursive watch with depth cap; richer per-folder rules (scope/sensitivity hints per folder).

## 7. Changelog

- 2026-06-07 — **Forks ratified + cleared for merge/build** (KB-Lead, Principal-directed). Resolutions: (#1) changed watched file → **new immutable source, provenance-linked** (DATA immutability); (#2) default **non-destructive copy**, consume-mode → Slice 2; (#3) v1 **non-recursive, no symlink-follow** (scope-escape security); (#4) **chokidar**, E1-pinned ≥7-day. No requirement changes — all four were build-time leans now locked. Cleared to merge + dispatch Slice 1.
- 2026-06-06 — **Spec created** (Principal — named folder-watch + the reusable ingestion pattern as a priority Ingest gap). Framed as a connector onto INGEST (SPEC-0008), not a new pipeline; deferred QCAP/RICHIN/INTAKE to their own specs. Drafted for review — NOT self-merging.
