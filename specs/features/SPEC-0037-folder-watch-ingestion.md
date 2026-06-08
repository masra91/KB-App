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
| WATCH-4  | must     | **Copy-first + never-destroy** (read-only world, AUTO-6): the watcher **copies content into the KB FIRST** (the source is durably preserved before anything happens to the original) and **never deletes or modifies** the watched original. Whether the original is then **left in place** (copy mode) or **moved to the archive** (drain/consume mode, WATCH-14) is the per-folder mode set by **WATCH-16** — a move-to-archive is not a delete-or-modify, so the never-destroy invariant holds in both modes | none-yet | AUTO-6; PRIN-1 |
| WATCH-5  | must     | **Restart-safe reconciliation**: on startup/after downtime the watcher reconciles each folder against already-ingested sources — files that appeared while it was down are still ingested (no missed-event loss), already-ingested files are skipped (no re-ingest) | none-yet | PRIN-1; INGEST-8 |
| WATCH-6  | must     | **No-loop / no-pollution**: the watcher refuses to watch the KB vault itself, its `.kb/`/`.git`/`.obsidian` internals, or any path that would re-ingest KB-produced files — so promotion/Enrich writes can never feed back as new arrivals | none-yet | CANON; PRIN-1 |
| WATCH-7  | must     | **Bounded + guarded**: ignore globs (dotfiles, `*.part`/`*.crdownload`/`*.tmp`, editor swap files), a max file size, and a per-window ingest cap so a bulk dump or runaway can't flood the pipeline; an ignored/oversize/unsupported file is **skipped with a logged reason** (OBS), never silently dropped | none-yet | PRIN-1; LIFE-6 |
| WATCH-8  | must     | **Durability inherited**: a classify/catalog failure leaves the file **preserved + flagged** (not lost), and a watcher crash mid-deliver neither double-ingests (WATCH-3 dedup) nor drops it (WATCH-5 reconcile) | none-yet | PRIN-1; INGEST-8,9 |
| WATCH-9  | should   | **Managed in the Control Panel → Sources** (SPEC-0027 PANEL): add/remove watched folders, enable/disable, see per-folder last-ingested + counts + any skipped-with-reason. The folder list is an editable surface (built on the WS2 design-system controls) | none-yet | PANEL-1 |
| WATCH-10 | should   | **macOS file access**: a watched folder outside the app's granted scope triggers the SPEC-0034 folder-permission flow before watching begins; denied → the folder reads as `needs permission`, not a silent no-op | none-yet | MACOS-7 |
| WATCH-11 | must     | Accepts the **same input kinds as INGEST** (INGEST-7: text/markdown/PDF/URL-file/…); an unsupported kind is a skip-with-reason (WATCH-7), not a crash and not a malformed source | none-yet | INGEST-7 |
| WATCH-12 | must     | **Recursive watch (opt-in, Slice 2)**: a folder may opt into **recursive** watching bounded by a **configurable depth cap** (default `5`, clamped ≤ `32`); default stays **non-recursive** (Slice-1 behavior unchanged). A nested file ingests with its **relative path** preserved in provenance. **`contentHash` stays the dedup-of-record (WATCH-3): identical content = ONE source regardless of path** (same bytes at two paths = one artifact, not two); the **relative path** is for provenance + the **reconcile/seen-ledger** (so distinct files at distinct subdir paths change-track independently) — NOT a replacement for contentHash dedup | test: `watchRecursive.test.ts` | INGEST-1,3; DATA-2 |
| WATCH-13 | must     | **Per-descended-path loop-guard (security, Slice 2)**: in recursive mode the WATCH-6 loop-guard is applied to **every descended directory** — a subdirectory whose **realpath** is the vault, inside the vault (`.kb`/`.git`/`.obsidian`/`sources`), or an ancestor of the vault is **skipped (never descended)**, the same realpath check as the root; **symlinked directories are never descended at any depth** (no-symlink-follow holds depth-wide) | test: `watchRecursive.test.ts` | CANON; PRIN-1; WATCH-6 |
| WATCH-14 | must     | **Consume / move-out (opt-in, Slice 2; non-destructive)**: a folder may opt into moving the original **out** after ingest — but the **copy into the KB happens FIRST** (the source is preserved before any move), the original is **MOVED** (never deleted) to a per-folder archive (`<folder>/.kb-processed/`, relative-path-preserving, a dot-dir so it is never re-ingested), a **failed ingest leaves the original untouched**, and an **existing archive entry is never clobbered** (never-delete ⊇ never-overwrite; cross-device → copy-then-unlink). Default stays non-destructive **copy** (WATCH-4) | test: `watchConsume.test.ts` | AUTO-6; PRIN-1 |
| WATCH-15 | should   | **Packaged-macOS fsevents**: the packaged macOS app ships `fsevents` (native module unpacked to `app.asar.unpacked`, require-able at runtime) so live folder-watch uses **fsevents**, not chokidar's `fs.watch` fallback — restoring fork #4's reliability rationale. v1 ships on the `fs.watch` fallback because the Vite-bundle packaging model copies no `node_modules` (`fsevents` is externalized so Rollup can bundle the mac build at all); shipping native `fsevents` is a packaging-model change, its own follow-up slice (see §6/§7). | none-yet | PRIN-1 |
| WATCH-16 | must     | **Drain-like-an-inbox is the DEFAULT** (Principal, 2026-06-07 — *"anything I put in there should rapidly be brought in… the folder should then appear empty — drains like an inbox"*). A watched folder **drains**: by default it runs in **consume/move-out** mode (WATCH-14 semantics — copy-into-KB FIRST, then **move** the original to `<folder>/.kb-processed/`, never delete, failed-ingest-leaves-original, never-clobber) so the folder **visibly empties** as items ingest — a draining inbox, not an accumulating pile. A per-folder **"leave originals in place (copy)"** opt-OUT (WATCH-4 copy mode) is available for those who want the source folder untouched. This **flips the prior WATCH-14 default** (was copy-default + consume opt-in). Ingestion is **prompt** — the stable-file settle window (WATCH-2) is the floor; **WATCH-15 (fsevents)** is the path to fsevents-grade liveness on packaged macOS so "rapid" holds | none-yet | AUTO-6; PRIN-1; WATCH-14 |

## 5. Open questions (forks) — RESOLVED (KB-Lead, 2026-06-07)

1. **Edit semantics → RATIFIED: a changed watched file is a NEW immutable source, provenance-linked to the prior** (not an in-place version). A watched file is an external artifact, not a KB-owned doc we edit in place; new-source-with-link is the only resolution consistent with DATA immutability (SPEC-0007). The dedup in WATCH-3 keys on `contentHash`, so an *unchanged* re-save is a no-op while a *changed* file ingests as a new source carrying a `derivedFrom`/prior-source provenance link.
2. **Consume mode → ~~default stays non-destructive copy~~ → REVERSED by the Principal (2026-06-07): DRAIN is the default (WATCH-16).** The move-out machinery (WATCH-14) stays as specified, but the *default* flips — a watched folder drains like an inbox (consume → `.kb-processed/`); copy-in-place is the opt-out. (Original Slice-2 framing kept the never-destroy invariant; only the default changed.)
3. **Recursion / symlinks → RATIFIED for v1: watch the configured folder NON-RECURSIVELY and DO NOT follow symlinks** (a symlink could resolve outside the granted macOS scope — security; WATCH-6/WATCH-10). Recursive watch (with a depth cap) is Slice 2.
4. **Engine → RATIFIED: use a vetted cross-platform watcher (`chokidar`), pinned + ≥7-day per E1** — `fs.watch` is unreliable for stable-file detection across platforms. Exact version pinned at build time under the E1 supply-chain rule.

## 6. Slices

- **Slice 1 (v1):** one or more watched folders; stable-file detection; copy→INGEST with watch provenance; contentHash dedup; restart reconcile; bounds + ignore globs; loop-guard; non-recursive + no-symlink-follow (forks #1/#3/#4 resolved above); Sources-view add/remove.
- **Slice 2:** recursive watch with a configurable depth cap + per-descended-path loop-guard (fork #3 → **WATCH-12/13**); consume/move-out mode (fork #2 → **WATCH-14**); both opt-in per-folder, defaults unchanged. Manage surface (WATCH-9) gains the per-folder recursive/depth/consume controls. Richer per-folder scope/sensitivity hints remain a later increment.
- **Follow-up (WATCH-15):** ship native `fsevents` in the packaged macOS app (packaging-model change) so packaged-mac live-watch uses fsevents, not the `fs.watch` fallback v1 runs on.

## 7. Changelog

- 2026-06-07 — **WATCH-16: drain-like-an-inbox is now the DEFAULT** (Principal — observed a watched folder *accumulating* copies instead of emptying; *"I thought anything I put in there would rapidly be brought in… folder should then appear empty — drains like an inbox"*). **Reverses the §5 fork-#2 ratification** (which made consume opt-in, copy the default): the per-folder default flips to **consume/move-out** (WATCH-14 semantics — copy-into-KB-first, then move the original to `<folder>/.kb-processed/`, never delete), so the folder visibly empties; **copy-in-place becomes the opt-out**. The never-destroy invariant is unchanged (WATCH-4 reworded to "copy-first + never-destroy", mode-agnostic). "Rapid" rides on the WATCH-2 settle-window floor + **WATCH-15 (fsevents)** for packaged-mac liveness. Impl: flip the default + surface the copy opt-out in the Sources view (WATCH-9); verify the folder empties on success and accumulates nothing.
- 2026-06-08 — **WATCH-15 added (should) + fsevents trade-off accepted for v1** (KB-Lead product ruling on the #250 P0 macOS-packaging fix). The fix externalizes `fsevents` (chokidar's macOS-only native dep — Rollup can't bundle the `.node`, which broke the mac `npm run package`) so the mac `.app` builds + launches; **v1 packaged-mac WATCH therefore runs on chokidar's `fs.watch` fallback, not fsevents** — a knowing divergence from fork #4, accepted because v1 is **non-recursive** (WATCH-6) + **restart-reconciled** (WATCH-5/8), which shrink the fallback's gap. **WATCH-15** tracks shipping native `fsevents` (a packaging-model change) to restore fsevents-grade liveness. The fix also added a `macos-latest` leg to the `package build-check` CI matrix — the durable fails-before/passes-after catch for the native-dep-bundling class the ubuntu-only matrix missed.
- 2026-06-07 — **Slice 2 requirements added (WATCH-12/13/14)** (KB-Developer-2, against KB-Lead's ratified Slice-2 dispatch). Recursive watch + configurable depth cap (WATCH-12), per-descended-path realpath loop-guard + depth-wide no-symlink (WATCH-13), and opt-in non-destructive consume/move-out (WATCH-14). All opt-in per-folder; Slice-1 defaults unchanged. Implemented + requirement-traced in the same change (SPECSYS-7).
- 2026-06-07 — **Forks ratified + cleared for merge/build** (KB-Lead, Principal-directed). Resolutions: (#1) changed watched file → **new immutable source, provenance-linked** (DATA immutability); (#2) default **non-destructive copy**, consume-mode → Slice 2; (#3) v1 **non-recursive, no symlink-follow** (scope-escape security); (#4) **chokidar**, E1-pinned ≥7-day. No requirement changes — all four were build-time leans now locked. Cleared to merge + dispatch Slice 1.
- 2026-06-06 — **Spec created** (Principal — named folder-watch + the reusable ingestion pattern as a priority Ingest gap). Framed as a connector onto INGEST (SPEC-0008), not a new pipeline; deferred QCAP/RICHIN/INTAKE to their own specs. Drafted for review — NOT self-merging.
