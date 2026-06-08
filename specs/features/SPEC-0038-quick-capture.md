---
spec: SPEC-0038
key: QCAP
title: Quick Capture (frictionless global capture surface; macOS first)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0003, SPEC-0008, SPEC-0010, SPEC-0013, SPEC-0017, SPEC-0034]
stage: Ingest
supersedes: null
---

# Quick Capture (frictionless global capture surface; macOS first)

> Capture from **anywhere**, without switching into the app: a **global hotkey** summons a
> lightweight sheet, or a **menubar** item is always one click away — type/paste, hit enter,
> it's preserved, the sheet vanishes and focus returns to whatever you were doing. *"I'm
> reading something — ⌥Space, paste, enter, gone."* QCAP is a **surface on the Capture/INGEST
> path** (SPEC-0013 → SPEC-0008), not new preservation plumbing.

## 1. Intent (the why / JTBD)

VISION-13 ranks *"quick capture, effortless recall"* first. SPEC-0013 delivered capture **inside
the app window** — but the highest-value capture happens when you're *not* in the app: mid-read,
mid-call, mid-thought. Forcing a window-switch is the friction that kills capture. QCAP removes
it: capture is summonable **system-wide**, **instant**, and **fire-and-forget**, so the cost of
saving a thought approaches zero. Because the surface is the only platform-specific part, this
spec ships **macOS first** and leaves other OSes as additive surfaces over the same shared spine.

## 2. Scope

**In:** a global hotkey + menubar capture surface; a minimal always-available capture sheet
(text/paste, current clipboard); fire-and-forget delivery onto the SPEC-0013 capture path;
headless operation; hotkey config; the macOS permission story.
**Out (deferred / other specs):** rich composition & multi-file drag (RICHIN); folder/programmatic
ingress (WATCH, SPEC-0037); scheduled outbound pulls (INTAKE); Windows/Linux surfaces (later
slices of THIS spec — the spine is shared, only the surface is added).

## 3. The flow

```
[global hotkey  OR  menubar click]   ← available with NO main window open (headless, LSUIElement)
        │
        ▼
   lightweight capture SHEET appears instantly (text field, pre-filled with clipboard optional)
        │   type/paste → Enter (submit)   |   Esc (cancel)
        ▼
   deliver to the SPEC-0013 capture path → INGEST spine: preserve immutably (ULID, raw,
        provenance surface=`quick-capture`) → commit → enqueue Enrich   [fire-and-forget, CAPTURE-2]
        │
        ▼
   sheet shows a brief "saved" confirmation, then DISMISSES and returns focus to the prior app
```

## 4. Requirements

| ID      | Priority | Statement (short) | Verify | Traces |
| ------- | -------- | ----------------- | ------ | ------ |
| QCAP-1  | must     | Capture is summonable **system-wide without the main window** — a **global hotkey** opens a lightweight capture sheet from any app. QCAP is a **surface onto the SPEC-0013 capture path**; it adds NO preservation logic — it reuses CAPTURE-2..15 (immutable raw, ULID, provenance, durable, enqueue Enrich) | none-yet | VISION-13; CAPTURE-1; INGEST-1 |
| QCAP-2  | must     | **Fire-and-forget + fast-out**: the sheet confirms as soon as the item is preserved (never blocks on Enrich, CAPTURE-2), then **auto-dismisses and restores focus** to the previously-active app — zero context switch into the full app | none-yet | VISION-1,13; CAPTURE-2 |
| QCAP-3  | must     | A **menubar/tray item** is the always-present, discoverable entry point: open the sheet, and a visible sign that capture is alive (complements the hotkey for users who don't recall it) | none-yet | VISION-13; PANEL-1 |
| QCAP-4  | must     | Quick capture works **headless** — with the app running only in the background and **no window open** (CAPTURE-12 / VISION-10); the background process owns the hotkey + sheet | none-yet | VISION-10; CAPTURE-12; ORCH-1 |
| QCAP-5  | must     | Provenance records `surface = quick-capture` (CAPTURE-6/13) so a quick-captured source is distinguishable in Activity/Audit from panel/watch/research arrivals | none-yet | INGEST-3; DATA-5; CAPTURE-13 |
| QCAP-6  | must     | The **global hotkey is Principal-configurable** in Settings, **conflict-aware** (warns on an OS/other-app clash), with a shipped default; a captured hotkey never silently no-ops | none-yet | SETUP; PANEL-1 |
| QCAP-7  | should   | **One-keystroke "capture this"**: the sheet can pre-fill from the **current clipboard** (and, where the OS permits, the current selection) so saving what you're looking at is a single gesture | none-yet | VISION-1,13 |
| QCAP-8  | must     | **macOS first; present BOTH a Dock app AND a persistent tray agent** (Principal revision, 2026-06-08 — the original "LSUIElement accessory, *no* dock icon" hid it from the Dock; he wants the Dock presence back **and** tray persistence, "do both"). The app is a **normal windowed Dock app** (Dock icon, Cmd-Tab, app menu) **and** a **persistent menubar/tray agent**: **closing the main window does NOT quit** — the app stays alive in the tray with the background pipeline + global hotkey running (QCAP-4), and the tray **"Show KB-App"** (QCAP-11) / hotkey **reopen the window**. Default **single-process** (`LSUIElement=false` so the Dock icon shows + **don't-quit-on-`window-all-closed`**; optionally `app.dock.hide()` when windowless for a pure-tray feel, `show()` on reopen); a **separate background-agent process is an acceptable fallback** if the headless hotkey/tray requires it ("separate process if need be idc"). Global hotkey via the OS API. Windows/Linux are **explicitly deferred slices** — only the surface differs; the Capture/INGEST spine is shared + unchanged | none-yet | STACK; SHELL; VISION-13; QCAP-4,11 |
| QCAP-9  | must     | **Honest macOS permissions**: any entitlement the hotkey/selection-capture needs (Accessibility / Input Monitoring) is requested with a clear explanation (the SPEC-0034 permission-UX pattern); **denied → degrade to menubar-click capture**, never a silently-dead hotkey | none-yet | MACOS-7; PRIN |
| QCAP-10 | should   | **Trustworthy confirmation**: a brief, non-modal "saved" signal (sheet flash / subtle toast) so fire-and-forget feels safe — never a blocking dialog | none-yet | VISION-1; CAPTURE-11 |
| QCAP-11 | must     | **Restore the main window from the menubar.** The tray menu (QCAP-3) includes a **"Show KB-App"** item that opens/restores the windowed app — **creating the window if none exists** (`app.show()` + window `show()`/`focus()`, front-most) — so the `LSUIElement` accessory (QCAP-4/8) is **never a one-way trap**: a user who closed or hid the main window can always get back to it from the menubar. Today the tray menu is **only** Capture + Quit (no restore) | none-yet | QCAP-3,4; PANEL-1 |
| QCAP-12 | must     | **Capture-sheet controls are always on-screen — no scroll-to-save.** The sheet's actions (**Save / Confirm / Cancel**) sit in a **fixed/sticky footer always visible without scrolling**; the sheet sizes so the action row **never clips** regardless of content height (the textarea scrolls internally; the footer does not move). Matches the DESIGN-QCAP command-bar intent — a minimal slot with actions instantly reachable. *(Principal hit a sheet where Save required scrolling — the button row is currently a flex child, not a pinned footer.)* | none-yet | QCAP-2,10; DESIGN-QCAP |
| QCAP-13 | should   | **Screenshot capture (Slice 2).** The sheet offers **Full screen / Region / Window** buttons — macOS `screencapture -x` (full, silent) / `-i` (interactive drag-region) / `-w` (window pick) → temp PNG → attached as a captured **source** through the SPEC-0013 path (`surface=quick-capture`, image kind). Requests **Screen-Recording** permission via the QCAP-9 honest-permission pattern; **denied → graceful degrade** to "paste a screenshot instead" (clipboard image), never a dead button. **Extends the v1 text+clipboard payload** (ratified fork #3) — an explicit Principal-requested Slice-2 capability, kept as an **opt-in affordance** off the zero-friction text path | none-yet | QCAP-7,9; MACOS-7; CAPTURE-1 |
| QCAP-14 | should   | **Tray live-status readout (read-only).** The menubar/tray surface (QCAP-3) shows a **compact, at-a-glance indicator that work is happening + how much remains** — e.g. *"~1,000 tasks pending across all jobs"*, or per-stage queue depths, or a simple working/idle dot — so the Principal can glance at the menubar without opening the app. **Composes the existing OBS pipeline-status view-model** (SPEC-0030 OBS-5: per-stage queue depth + state); **read-only** (the observatory invariant, AUDIT-8 / OBS-9 — no actions beyond QCAP-11 restore + the QUIESCE-1 prepare-shutdown). Updates on tray-open (and/or live while open). Grows with the Status view — as OBS/VIZ improve, this is their menubar-sized summary | none-yet | QCAP-3; OBS-5,9; SPEC-0030; SPEC-0045 |

## 5. Open questions (forks) — RESOLVED (KB-Lead + Principal, 2026-06-07)

1. **Default hotkey → RATIFIED: `⌥Space` (Option+Space)** — Principal's pick. Ergonomic one-handed summon; avoids ⌘Space (Spotlight). Ships as the **default only** — QCAP-6 keeps it user-configurable + conflict-aware (warns on an OS/other-app clash, e.g. if a launcher already owns ⌥Space; never a silently-dead hotkey).
2. **Selection capture → RATIFIED: clipboard-only for v1 (zero macOS permission).** No Accessibility/Input-Monitoring entitlement in Slice 1 — the frictionless win is hotkey→sheet→clipboard-prefill. Reading the *focused selection* via the Accessibility API (with its permission UX, QCAP-9) moves to **Slice 2** (fork carried there).
3. **Sheet payload v1 → RATIFIED: text + clipboard only.** File-drop / rich composition stays out of the frictionless sheet — that's RICHIN + the in-app panel. Keeps QCAP the zero-friction path.
4. **App model → RATIFIED: a `LSUIElement` menubar agent (no forced dock icon)** that owns the global hotkey + sheet headlessly — the right model for an always-available accessory (QCAP-4/8). The existing windowed app composes with it over the shared SPEC-0013/0008 spine; the SPEC-0010 shell gains the accessory/agent process, not a second pipeline.

## 6. Slices

- **Slice 1 (macOS v1):** menubar agent + configurable global hotkey → text/clipboard capture sheet → SPEC-0013 path → confirm + auto-dismiss; headless; `surface=quick-capture`. Resolves forks #1 (ship a default), #3 (text/clipboard), #4.
- **Slice 2 (macOS):** ✅ **selection capture (fork #2) + permission UX — done:** the menubar agent reads
  the focused-app selection on summon (before the sheet steals focus) behind the Accessibility grant;
  denied → a steer-to-Settings affordance + graceful degrade to clipboard-only (QCAP-9); the sheet
  prefers the selection over the clipboard as the "capture this" affordance (QCAP-7); the Slice-1
  fast-out / focus-restore / zero-permission fallback are preserved. **Remaining Slice 2:** **screenshot
  capture (QCAP-13: full/region/window via `screencapture` + Screen-Recording permission)**, the
  **menubar "Show KB-App" restore (QCAP-11)**, the **sticky-footer sheet (QCAP-12)**, richer sheet.
  *(QCAP-11/12 are small Principal-reported gaps — can land ahead of the rest of Slice 2.)*
- **Slice 3+:** Windows / Linux surfaces over the same spine.

## 7. Changelog

- 2026-06-08 — **Slice 2 (part 1) implemented** (macOS selection capture + permission UX; fork #2 resolved). The
  agent reads the focused-app text selection on summon via the macOS Accessibility grant (probed, not
  prompted, per summon), BEFORE the sheet steals focus; a denied grant / read failure / non-macOS
  degrades to clipboard-only and surfaces a steer-to-Settings affordance (menubar item + sheet) — never
  a silently-dead feature (QCAP-9). The sheet prefers the selection over the clipboard (QCAP-7). No
  native module (synthetic ⌘C with clipboard restore, bounded) — E1-clean. No requirement changes.
  (QCAP-11/12/13 — menubar restore, sticky-footer, screenshot — remain the rest of Slice 2.)
- 2026-06-07 — **QCAP-11/12/13: menubar restore + no-scroll sheet + screenshot capture** (Principal, from using Slice 1). Three gaps observed in the shipped menubar agent: (11) the tray menu is **only Capture + Quit** — no way to **restore the main window** from the menubar, so the `LSUIElement` accessory is a one-way trap → add a "Show KB-App" item that creates/shows/focuses the window; (12) the capture sheet's **Save button can require scrolling** (the action row is a flex child, not a pinned footer) → **sticky footer**, Save/Confirm/Cancel always on-screen (DESIGN-QCAP command-bar intent); (13) **screenshot capture** — Full/Region/Window via macOS `screencapture -x/-i/-w` → temp PNG → SPEC-0013 source, behind Screen-Recording permission (QCAP-9 degrade), an opt-in affordance extending the v1 text-only payload (fork #3). QCAP-11/12 are small fixes (can land ahead of Slice 2); QCAP-13 is a Slice-2 capability. Visual layout of the sheet footer + capture buttons → KB-Design-Lead; tray + `screencapture` plumbing → dev.
- 2026-06-07 — **Forks ratified + cleared for merge/build** (KB-Lead + Principal). (#1) default hotkey = **`⌥Space`** (Principal's pick; configurable via QCAP-6); (#2) v1 **clipboard-only, zero-permission** (selection-capture → Slice 2); (#3) v1 payload **text + clipboard only** (file/rich → RICHIN); (#4) **`LSUIElement` menubar agent** owning the hotkey headlessly. No requirement changes. Cleared to merge + dispatch Slice 1.
- 2026-06-06 — **Spec created** (Principal — named quick capture as a priority Ingest gap, "highly platform-dependent, start with macOS"). Framed as a surface on the SPEC-0013 → SPEC-0008 capture path (no new preservation logic); macOS-first with other OSes as additive surface slices. Number is SPEC-0038 (SPEC-0037/WATCH reserved in PR #217). Drafted for review — NOT self-merging.
