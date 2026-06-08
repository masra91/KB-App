---
design: DESIGN-QCAP
implements: SPEC-0038
title: Quick Capture — Visual Design ("the intake slot")
type: design
status: draft   # awaiting SPEC-0033 gates: GATE 1 (AI-Detector / distinctiveness) + GATE 2 (KB-QD / flow coverage)
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-07
updated: 2026-06-08
related: [SPEC-0038, SPEC-0033, _design-system, SPEC-0013, SPEC-0032, SPEC-0034]
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector (distinctiveness) — the MOST-summoned surface; must not be a generic capture box
  qa-flow-coverage: pending # GATE 2 — KB-Quality-Driver (QCAP key flows: summon → type/paste → save → confirm → dismiss)
stage: Ingest
---

# Quick Capture — Visual Design ("the intake slot")

> The design for SPEC-0038's global capture surface — summoned from anywhere by `⌥Space` or the
> menubar. It is the **most-summoned surface in the app**, so it carries the most identity risk: a
> capture sheet is the textbook generic-AI shape (a rounded card on a dimmed scrim, a chat-style box,
> a filled-blue **Send**). This design refuses that. QCAP is **the intake mouth of "The Line"** — a
> flat, ruled, graphite **instrument slot** you drop a raw thought into; the line **ember-acknowledges**
> it and the slot vanishes. Built on the shared `_design-system.md` language. Implementation aligns to
> this; DEV-1's hotkey/agent/INGEST plumbing is **not gated** on it (parallel).

Three things to design (KB-Lead's scope): **(§3) the floating capture sheet**, **(§4) the menubar
presence**, **(§5) the non-modal "saved" confirm.**

## 1. The concept — the intake slot, not a capture box

SPEC-0032 made the pipeline a **refinery line** that refines raw capture into knowledge. QCAP is
**where raw material enters that line** — the intake. So the sheet is not a "note dialog"; it's the
**loading slot of an instrument**: a flat graphite panel, a single ruled intake field, and — the
signature move — when you commit, the line's **ember heat** runs the rule (the billet entered) and the
slot closes. The whole interaction is **keyboard-first and sub-second**: summon, type/paste, `⏎`, gone.

What this is **not** (the anti-generic guardrail, GATE 1): no rounded card / drop-shadow material; no
dimmed-purple scrim; no chat bubble; no filled-indigo **Send** button; no avatar/sparkle/“AI” chrome.
The sheet looks like a **panel on a precision instrument**, not a webapp modal.

## 2. Form & placement (the floating sheet as instrument, not card)

- **Frameless panel.** A borderless OS panel (no title bar / traffic lights — it's an `LSUIElement`
  accessory), so the **instrument fills the whole surface**. The window *is* the slot.
- **Compact command-bar proportions.** A fixed, narrow sheet (~`520px` wide, height grows with content
  from a single input row) — reads as a *tool you summon*, like a command palette, not a document.
- **Anchored high-center.** Appears in the **upper third** of the focused screen (command-bar
  convention) — close to where the eye/menubar is, never centered like a blocking modal.
- **Flat-ink edge, not card chrome.** Ground is `--viz-field` (graphite). Edge definition is a **1px
  `--viz-rule` border + a single 2px `--viz-ember` hairline along the TOP** (the "live line" — the
  instrument is powered) — **not** a soft drop shadow. A faint scrim is allowed only as the lightest
  possible separation (≤8% black), never the dimming-modal treatment.
- `.viz-surface` provides the ground + type roles + the reduced-motion reset.

## 3. The capture field (the hero — an EditableField at instrument scale)

The sheet is **mostly one field**. It composes the WS2 **EditableField `multiline`** primitive at hero
scale — the same `--viz-field` ground, `--viz-rule` rule, **ember rule on focus** — so capture reads in
the same language as everything else, just bigger and barer.

- **One intake field, autofocused.** On summon, focus is **already in the field** (zero clicks). It
  grows from one row; `--viz-font-body` (IBM Plex Sans), comfortable reading size.
- **A whisper of signage, not a form.** A single small `--viz-font-signage` tick in the corner — the
  word `CAPTURE` or just the `⌥Space` glyph — and the submit hint in `--viz-font-numeric` mono:
  `⏎ save · esc dismiss`. No labels, no field chrome, no placeholder paragraph. The slot is obvious.
- **Clipboard pre-fill = a "loaded" state (QCAP-7).** When the sheet opens pre-filled from the
  clipboard, the prefilled text sits in the field with a **left `--viz-rule` tick + a tiny mono
  `clipboard` tag** so it's legible that this is *loaded* material you can edit/clear, not text you
  typed. Clearing it (or typing) drops the tag. One gesture: summon → `⏎` saves the clipboard.
- **Submit is the keystroke, not a button.** `⏎` submits; the design is keyboard-first. A single
  **`ghost` Button** (`⏎ save`) appears at the trailing edge for discoverability/mouse users — ghost,
  not a filled primary, so the keystroke stays the protagonist. `⇧⏎` = newline.
- **Empty input creates nothing, and `⏎` is a frictionless cancel (no junk in the KB).** When the field
  is empty or whitespace-only: **no source is created** and **no ember-acknowledge fires** (nothing was
  preserved, so the §5 confirm stays silent). `⏎` on an empty field is a **frictionless cancel** — it
  dismisses the sheet and restores focus, same as `Esc` (so `⏎` always means "I'm done here": it saves
  *and* dismisses when there's content, just dismisses when there isn't — one consistent keystroke). An
  accidental summon therefore never writes an empty source into the user's vault (KB-QD invariant, #249
  gate-2; implemented + tested in #251).

## 3a. The command bar — a sticky instrument footer (QCAP-12)

The submit affordances (`⏎ save` ghost button + the `⏎ save · esc dismiss` hint + the live status note)
form a **command bar** that must be **always on-screen** — it can never scroll off, even when pasted/typed
content overflows the compact ~200px window. Today it can: the field is `flex: 1` with no `min-height: 0`,
so a tall paste pushes the `.qcap-row` below the fold (`qcap.css:71` row / `:32` field) and the user loses
the save/cancel actions. That contradicts the command-bar intent (§2): the actions are the instrument's
**fixed footer rail**, not the tail of a scrolling document.

- **The field flexes and scrolls; the command bar is pinned.** The intake field becomes the *only* region
  that gives: `flex: 1 1 auto` **+ `min-height: 0`** so it can shrink below its content, and the textarea
  **scrolls internally** (`overflow-y: auto`) instead of growing the sheet. The command bar is **`flex: none`**
  — it never shrinks and always sits at the bottom edge of the slot.
- **A ruled footer, flat (no shadow).** The command bar gets a **1px `--viz-rule` hairline along its TOP**
  (the footer rail of the instrument — mirrors the §2 top ember hairline at the head), with the existing
  `8px` rhythm above it. When the field scrolls under it, the rule is the clean visual anchor — never a
  drop-shadow or a floating-toolbar treatment.
- **Save = confirm, Esc = cancel — both always reachable.** Keyboard-first stays the protagonist (`⏎`
  saves, `Esc` cancels), but their on-screen affordances (the ghost `⏎ save` button and the `esc dismiss`
  hint) are now **guaranteed visible** for mouse/discoverability users. The button keeps its WS2 disabled
  state on an empty field (§3). No new control — this is the existing `.qcap-row` promoted to a pinned,
  ruled footer.
- **Reduced-motion / contrast unaffected** — purely structural; the ember/oxide/patina state treatments
  (§5) ride on the field rule exactly as before.

## 3b. Screenshot capture — an alternate intake source (QCAP-13)

A second way to *load the slot*: capture a screenshot straight into the field, alongside type / paste /
clipboard. Three modes — **Full screen · Region · Window** — that trigger the macOS `screencapture` path.
This stays an **instrument**, not a generic camera widget.

- **A spare icon-button cluster, not a toolbar.** Three **ghost icon-buttons** (`.viz-btn--ghost`,
  icon-only) grouped at the **trailing edge of the `.qcap-head`** (next to the source tag) — thin,
  instrument-line template glyphs (a full-frame rect, a crop/region rect, a window rect), **never** a
  📷/camera emoji or a filled "Capture" button. They're secondary to the field: muted `--viz-ink-muted`
  ink at rest, ember on hover/focus (the `.viz-focusable` ring), so the keyboard intake stays the hero.
- **Captured image = a "loaded" state, tagged by source.** A screenshot loads into the slot the same way
  clipboard/selection do (§3, QCAP-7): the field enters `is-loaded` with a **`screenshot` source tag** —
  the identical `.viz-chip` + left `--viz-rule` tick pattern as `clipboard` / `selection` (one consistent
  "this is loaded material" language). `⏎` saves it in one gesture.
- **Permission UX reuses the QCAP-9 brass semantic.** Screen-Recording TCC not yet granted → the cluster
  shows the **same quiet brass steer** as the selection-capture affordance (`selection capture off — enable`
  → Settings · Privacy · Screen Recording): **`--viz-brass` (needs-you), NOT `--viz-oxide`** — a denied
  permission is *waiting on you*, not a crash (the locked semantic, `macos-permission.md §3/§6`; ratified
  on PR #258). Denied → **graceful degrade to paste-an-image** (the clipboard path still loads an image),
  never a dead end. Each button carries an explicit `aria-label` (`Capture full screen` / `Capture a
  region` / `Capture a window`) — icon-only buttons need an accessible name.
- **Scope note.** QCAP-13 brings **image-via-screenshot** into the QCAP slot (text · clipboard · selection
  · screenshot); arbitrary **file-drop / rich payloads remain RICHIN** (§9) — this is a bounded capture
  source, not a general attachment surface.

## 4. The menubar presence (always-there, quietly alive — QCAP-3)

- **The mark, not a generic glyph.** The menubar item is the **app's instrument mark** (the same
  identity as the line), monochrome template icon per macOS convention — never a generic ✎/＋/speech
  bubble.
- **"Capture is alive" = a quiet ember.** The icon carries the instrument state: at rest it's the
  template ink; when the background agent is **live + healthy** a **single ember pip** (or an ember-tinted
  accent on the mark) signals the line is powered and listening — the one place the always-on agent
  shows it's alive (QCAP-3), echoing the sheet's top ember hairline. Degraded/permission-denied
  (QCAP-9) shows the mark in `--viz-brass` (a caution tick), never silently normal.
- **Minimal menu.** Click the item → it **opens the same sheet** (primary action). The dropdown is
  spare, instrument-plain: `Capture  ⌥Space` · a muted `last saved <ago>` line (trust signal) ·
  `Settings…` · `Quit`. No marketing, no nav — it's a control, not a launcher.

## 5. The "saved" confirm — the ember acknowledge (non-modal — QCAP-10)

The fire-and-forget moment. It must feel **safe** (the thought is preserved) without a blocking dialog,
and it must be **fast** (the sheet auto-dismisses). The signature treatment:

- **The line takes it.** On `⏎`, the field's rule **sweeps `--viz-ember` left→right once** (the billet
  entered the line — the app's signature heat, reusing the `--viz-ember` + `--viz-dur-index` 220ms
  index motion), and a brief `--viz-patina` (settled/preserved) signage flick reads **`preserved`**
  (patina = the same "settled/promoted" hue the pipeline uses for committed material).
- **Then it's gone.** The sheet **auto-dismisses ~350–500ms** after the acknowledge and **restores
  focus** to the prior app (QCAP-2). The whole confirm→dismiss is sub-second; you never wait.
- **Never a dialog/toast-with-a-button.** No "Saved ✓ [OK]", no center-screen toast card. The confirm
  is the instrument's own rule lighting + the one-word patina tick, in-surface.
- **Failure (rare) is distinct & holds.** If preservation fails, the rule goes `--viz-oxide` (border/
  glyph, text stays ink per the §2 contrast contract) with a held `couldn't save — ⏎ retry` — it does
  **not** auto-dismiss (the one case the sheet stays, so a lost capture is impossible to miss).

## 6. Color, type, motion (inherited from `_design-system.md`)

- **Color** — `--viz-field` ground, `--viz-ink` text, `--viz-ink-muted` for the hints/tags,
  `--viz-rule` for structure, **`--viz-ember`** for the live hairline + the save sweep,
  **`--viz-patina`** for `preserved`, `--viz-brass`/`--viz-oxide` for degraded/failed. Dark default +
  the light "draughting paper" override come free from the tokens.
- **Type** — `--viz-font-body` for the captured text (it's prose); `--viz-font-signage` for the
  `CAPTURE` tick; `--viz-font-numeric` for the `⌥Space` / `⏎ save` / `last saved` hints (mono, tabular).
- **Motion** — summon: a fast **120–160ms** fade+rise (faster than the standard index hop — this is
  summoned constantly, it must feel instant). Save: the `--viz-ember` rule sweep (`--viz-dur-index`).
  **Reduced-motion**: summon is instant, the save sweep becomes an instant ember rule + the `preserved`
  text (the confirm still reads via hue + word, nothing lost — the §5 reduced-motion parity rule).

## 7. Accessibility

- **Keyboard is the surface.** Autofocus into the field on summon; `⏎` save, `⇧⏎` newline, `Esc`
  cancel + **restore focus to the prior app** (QCAP-2). No pointer ever required.
- **Confirm is announced, not just lit.** The `preserved` / `couldn't save` state is an
  `aria-live="assertive"` region so a non-visual user hears the fire-and-forget result — the ember
  sweep is reinforcement, never the sole signal (color-independent, per DESIGN-4 / the §2 contract).
- **Focus ring** is the ember `.viz-focusable` ring (≥3:1), never framework indigo.
- **The menubar "alive" state** is reinforced by the menu's `last saved <ago>` text + a tooltip, so the
  ember pip isn't the only indicator of liveness.

## 8. Key flows covered (GATE 2 / KB-QD)

1. **Summon → type → save → gone** — `⌥Space` → autofocused field → type → `⏎` → ember acknowledge +
   `preserved` → auto-dismiss + focus restored. (QCAP-1/2/10)
2. **One-gesture clipboard capture** — `⌥Space` (sheet opens clipboard-loaded, tagged) → `⏎`. (QCAP-7)
3. **Cancel** — `⌥Space` → `Esc` → sheet gone, nothing saved, focus restored.
4. **Menubar entry** — click the menubar mark → same sheet; the mark shows capture is alive. (QCAP-3)
5. **Save failed** — the rare case: oxide rule + held `couldn't save — ⏎ retry`, no auto-dismiss. (QCAP-10)
6. **Degraded permission** — brass menubar mark; capture still works via menubar-click. (QCAP-9)
7. **Empty `⏎` = frictionless cancel** — `⌥Space` → `⏎` on an empty/whitespace field → no source, no
   acknowledge; the sheet dismisses + restores focus (same as `Esc`). §3. No empty source ever reaches
   the vault. (KB-QD #249 gate-2 invariant; impl/tested in #251)
8. **Overflowing capture, actions still reachable** — paste/type past the compact window → the field
   scrolls internally, the **command bar stays pinned** at the bottom; `⏎ save` / `esc dismiss` never
   scroll off. (QCAP-12, §3a)
9. **Screenshot → save** — click Region (or Full screen / Window) → `screencapture` → image loads as a
   tagged `screenshot` "loaded" state → `⏎` saves. (QCAP-13, §3b)
10. **Screen-Recording denied** — the screenshot cluster shows the **brass** steer (Settings · Privacy ·
    Screen Recording) and **degrades to paste-an-image**; capture still works, never a dead end. (QCAP-13/9, §3b)

## 9. Out of scope (deferred to SPEC-0038 later slices / other specs)

- **Arbitrary file-drop / rich payloads** — RICHIN. QCAP's bounded intake sources are text · clipboard ·
  selection (Slice 2) · screenshot (QCAP-13, §3b); general attachment is out of scope here.
- **Windows/Linux surfaces** — Slice 3+; the visual language ports, the platform chrome differs.
- **Migrating the in-app SPEC-0013 capture view** onto this language — desirable, but its own pass; out
  of scope here (QCAP is the global surface).
- **Hotkey-config UI in Settings** (QCAP-6) — lives in the Settings surface; a conflict-warning
  affordance there reuses ConfirmInline/EditableField, designed when that surface is touched.

## 10. Open questions

- [ ] **Screen anchor** — upper-third of the *focused* display vs. anchored under the menubar item when
      menubar-summoned? (Lean: upper-third always, for hotkey-summon consistency; DEV/UX call.)
- [ ] **"Alive" pip vs. tinted mark** — a discrete ember pip on the menubar icon, or an ember-tinted
      accent within the mark? (macOS template-icon constraints decide — DEV-1 call at wiring.)
- [ ] **`preserved` dwell** — exact auto-dismiss delay (350–500ms) to tune so it reads as confirmed
      without ever feeling like a wait. (Settle at impl; KB-QD verifies it never blocks.)

## 11. Changelog

- 2026-06-07 — created (draft). Visual design for SPEC-0038 Quick Capture, authored **up front, in
  parallel** with DEV-1's Slice-1 plumbing (KB-Lead dispatch: QCAP's sheet is **net-new visual + the
  most-summoned surface** — must not drift into a generic capture box). Designs the three scoped
  elements — the **floating capture sheet** (frameless flat-ink "intake slot", hero EditableField,
  keyboard-first), the **menubar presence** (instrument mark + quiet-ember "alive"), and the **non-modal
  "saved" confirm** (the `--viz-ember` rule-sweep acknowledge + `--viz-patina` `preserved`, auto-dismiss;
  oxide-held on failure) — all on the `_design-system.md` instrument language. Awaiting GATE 1
  (AI-Detector) + GATE 2 (KB-QD). DEV-1 aligns the sheet to this; I classify at DEV-1's impl PR.
- 2026-06-07 — **GATE 2 (KB-QD) PASSED**; added the **empty-input no-op invariant** (§3/§8) per KB-QD's
  non-blocking gate-2 note: empty/whitespace `⏎` creates no source, fires no acknowledge, keeps the
  sheet open, and disables the save Button (WS2 disabled state) — so an accidental summon never writes
  an empty source into the vault. Awaiting GATE 1 (AI-Detector).
- 2026-06-08 — **WS4 visuals added (§3a/§3b — QCAP-12/13)** from the Principal deep-pass (PR #266),
  authored in parallel for DEV-1 to plumb after Slice 2 (#258). **§3a QCAP-12** — the command bar becomes
  a **sticky, ruled instrument footer** (field flexes + `min-height:0` + internal scroll; `.qcap-row`
  `flex:none` + a 1px `--viz-rule` top hairline) so `⏎ save` / `esc dismiss` never scroll off the compact
  window. **§3b QCAP-13** — **screenshot capture** (Full screen · Region · Window) as a spare ghost
  icon-button cluster in the head, loading a `screenshot`-tagged "loaded" state (same `.viz-chip` pattern
  as clipboard/selection); Screen-Recording denial reuses the **brass** denied-permission steer (NOT
  oxide; the locked `macos-permission.md §3/§6` semantic, ratified on #258) and **degrades to paste-an-
  image**. No new tokens/components — all blessed primitives. Net-new visual → **KB-Lead classify/gate**.
