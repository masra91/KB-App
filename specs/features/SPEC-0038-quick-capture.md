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
| QCAP-8  | must     | **macOS first, surface-only platform dependence**: ships as a macOS **accessory/agent** app (menubar, no forced dock icon) with the global hotkey via the OS API. Windows/Linux are **explicitly deferred slices** — only the surface differs; the Capture/INGEST spine underneath is shared and unchanged | none-yet | STACK; VISION-13 |
| QCAP-9  | must     | **Honest macOS permissions**: any entitlement the hotkey/selection-capture needs (Accessibility / Input Monitoring) is requested with a clear explanation (the SPEC-0034 permission-UX pattern); **denied → degrade to menubar-click capture**, never a silently-dead hotkey | none-yet | MACOS-7; PRIN |
| QCAP-10 | should   | **Trustworthy confirmation**: a brief, non-modal "saved" signal (sheet flash / subtle toast) so fire-and-forget feels safe — never a blocking dialog | none-yet | VISION-1; CAPTURE-11 |

## 5. Open questions (forks) — RESOLVED (KB-Lead + Principal, 2026-06-07)

1. **Default hotkey → RATIFIED: `⌥Space` (Option+Space)** — Principal's pick. Ergonomic one-handed summon; avoids ⌘Space (Spotlight). Ships as the **default only** — QCAP-6 keeps it user-configurable + conflict-aware (warns on an OS/other-app clash, e.g. if a launcher already owns ⌥Space; never a silently-dead hotkey).
2. **Selection capture → RATIFIED: clipboard-only for v1 (zero macOS permission).** No Accessibility/Input-Monitoring entitlement in Slice 1 — the frictionless win is hotkey→sheet→clipboard-prefill. Reading the *focused selection* via the Accessibility API (with its permission UX, QCAP-9) moves to **Slice 2** (fork carried there).
3. **Sheet payload v1 → RATIFIED: text + clipboard only.** File-drop / rich composition stays out of the frictionless sheet — that's RICHIN + the in-app panel. Keeps QCAP the zero-friction path.
4. **App model → RATIFIED: a `LSUIElement` menubar agent (no forced dock icon)** that owns the global hotkey + sheet headlessly — the right model for an always-available accessory (QCAP-4/8). The existing windowed app composes with it over the shared SPEC-0013/0008 spine; the SPEC-0010 shell gains the accessory/agent process, not a second pipeline.

## 6. Slices

- **Slice 1 (macOS v1):** menubar agent + configurable global hotkey → text/clipboard capture sheet → SPEC-0013 path → confirm + auto-dismiss; headless; `surface=quick-capture`. Resolves forks #1 (ship a default), #3 (text/clipboard), #4.
- **Slice 2 (macOS):** selection capture (fork #2, with the permission UX), richer sheet, capture-this affordance.
- **Slice 3+:** Windows / Linux surfaces over the same spine.

## 7. Changelog

- 2026-06-07 — **Forks ratified + cleared for merge/build** (KB-Lead + Principal). (#1) default hotkey = **`⌥Space`** (Principal's pick; configurable via QCAP-6); (#2) v1 **clipboard-only, zero-permission** (selection-capture → Slice 2); (#3) v1 payload **text + clipboard only** (file/rich → RICHIN); (#4) **`LSUIElement` menubar agent** owning the hotkey headlessly. No requirement changes. Cleared to merge + dispatch Slice 1.
- 2026-06-06 — **Spec created** (Principal — named quick capture as a priority Ingest gap, "highly platform-dependent, start with macOS"). Framed as a surface on the SPEC-0013 → SPEC-0008 capture path (no new preservation logic); macOS-first with other OSes as additive surface slices. Number is SPEC-0038 (SPEC-0037/WATCH reserved in PR #217). Drafted for review — NOT self-merging.
