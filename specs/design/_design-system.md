---
design: DESIGN-SYS
implements: SPEC-0033
title: Design System — Shared Primitives ("The Line" instrument kit)
type: design
status: active   # both SPEC-0033 gates cleared 2026-06-06 → merged #223; implemented #225, migrations #226/#227
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0033, SPEC-0032, SPEC-0028, SPEC-0027, SPEC-0017, SPEC-0018]
gates:
  ai-patterns: approved      # GATE 1 — KB-AI-Detector, 2026-06-06 ("strongest anti-generic artifact in the corpus")
  qa-flow-coverage: approved # GATE 2 — KB-Quality-Driver, 2026-06-06 (cleared on the #223 merge)
stage: Cross-cutting
---

# Design System — Shared Primitives ("The Line" instrument kit)

> The **surface-agnostic component layer** of the visual language. SPEC-0033 DESIGN-7 says a shared
> design system *emerges from the per-surface specs over time*; this spec makes the first four
> primitives **deliberate and canonical** — promoting patterns already proven on **"The Line"**
> (SPEC-0032) and **"The Field Desk"** (SPEC-0028) into one documented kit, so feature surfaces
> **compose** them instead of re-inventing (or falling back to the generic look). This is the **pixels
> + rationale + a11y contract** for each primitive; the implementation (a dev hoisting the CSS/markup
> into the shared layer + migrating callers) is downstream WS2 dev work.

This spec is the **WS2 deliverable** of the Principal app-review (KB-Lead's 4-WS dispatch, 2026-06-06).
**WS2 gates WS3** (researcher config editors compose `EditableField` + `SegmentedControl`).

## 1. Intent (the why / JTBD)

The app currently carries **two visual languages**:

- **The legacy generic look** — `index.css` `--bg/--card/--accent` (indigo `#6c8cff`), `.card` chrome,
  `button.primary` (the blue pill), native `<select>`, `.field input`. Reads as a generic AI/SaaS app.
- **"The Line" instrument language** — `design-system.css` (`--viz-*` tokens, bundled type roles, flat
  ruled ink, ember heat, clearance temperatures). Distinct, deliberate, already shipped on two surfaces.

The instrument language proved itself, but its **interactive controls were built inline** inside each
surface (`.rdesk-arm`, `.rdesk-rung`, `.rdesk-seg-opt`, `.rdesk-input`, `.rdesk-confirm`). The next
surfaces (Jobs, Reviews, the rest of the Control Panel) still wear the legacy chrome. Without a shared
kit, every new surface either re-derives the instrument controls (drift) or reaches for the generic
defaults (regression to the AI look — exactly what SPEC-0033 GATE 1 exists to stop).

**WS2 fixes the fork:** four canonical primitives, in the instrument language, that every surface
composes. The legacy `--bg/--card/--accent` vocabulary is **deprecated on app chrome** as surfaces
migrate (the tokens stay only where genuinely needed; the goal is no new generic controls).

## 2. The foundation (already shipped — this spec builds ON it)

`app/src/shell/design-system.css` is the **token + utility floor** (SPEC-0033 DESIGN-7; documented as
DESIGN-VIZ §3–§6 on "The Line"). This spec does **not** redefine it — primitives reference these:

- **Color (§3)** — `--viz-field` (ground), `--viz-rule` (structure), `--viz-ink` / `--viz-ink-muted`
  (text), `--viz-idle` (at-rest), and the **state/clearance hues**: `--viz-ember` (active heat),
  `--viz-patina` (settled/promoted/local), `--viz-brass` (blocked/waiting/tenant),
  `--viz-oxide` (error/set-aside). Dark default + light ("draughting paper") override.
- **Type roles (§4)** — `--viz-font-signage` (Saira Condensed, uppercase labels), `--viz-font-numeric`
  (IBM Plex Mono, tabular figures), `--viz-font-body` (IBM Plex Sans). Utilities `.viz-signage`,
  `.viz-numeric`, `.viz-body`.
- **Motion (§5)** — `--viz-dur-index/breathe/odometer/state`, `--viz-ease-index/state`, the single
  `@keyframes viz-breathe` (opacity-only), and the **one** `prefers-reduced-motion` reset that zeroes
  all viz animation/transition (full functional parity — state still reads via glyph + hue + fill).
- **Flat-ink guardrails (§6)** — `.viz-no-chrome` (no radius/shadow/card bg), `.viz-ruled` / `.viz-spine`
  (structure is a *rule*, not a card edge), `.viz-focusable` (ember focus ring, **never** framework
  indigo). Plus existing bases `.viz-btn` and `.viz-chip`.

**The contrast contract (§3, non-negotiable, inherited by every primitive):** state hues color
**fills / glyphs / borders / large+display text only** (all ≥3:1). **Small body text (< ~18px) stays
`--viz-ink`** (≈14:1). In particular **`--viz-oxide` (3.96:1) must never color normal-size text** —
error/danger reads via an oxide *border or glyph* while the text stays ink. This is the rule that let
the typed report show a distinct "failed" without dropping below AA (KB-Design-Lead #184).

## 3. Primitive: **Button**

The single pressable-action primitive. Replaces every bespoke/legacy button: `button.primary`,
`.btn`, `.btn-danger`, `button.link`, `.rdesk-arm`, `.rdesk-run`, `.rdesk-tile`, the sidebar
`.nav-item`. Base already exists as `.viz-btn`; this promotes it to the documented primitive with a
full variant/size/state matrix.

**Anatomy** — a flat, near-square control: signage-cased label (optional leading glyph), 1px
`--viz-rule` border, `≤3px` radius (the *only* rounding allowed off-structure, §6), transparent
ground. No gradient, no drop shadow, no filled-indigo default.

**Variants** (intent, not decoration):

| Variant | Use | Resting | Hover/active |
| --- | --- | --- | --- |
| `default` | the common action | ink label, `--viz-rule` border, transparent | border + label → `--viz-ember` |
| `primary` | the one emphasized action in a group | ink label, `--viz-ink-muted` border | ember border + ember label |
| `danger` | irreversible / destructive | ink label, **`--viz-oxide` border** (text stays ink — contract §2) | label → oxide on hover |
| `ghost` | low-emphasis / inline (was `button.link`) | `--viz-ink-muted` label, no border | ember label, no fill |
| `clearance-tinted` | **surface-composed, not a shared Button variant yet** — Researchers tints arm/Run via `.rdesk-*` in its surface CSS. Promote to a shared `.viz-btn--clearance` (mirroring `.viz-seg-opt--clearance`) when a **2nd** surface needs clearance-colored buttons. | label/border take the strip's clearance hue (`patina`/`brass`/`ember`) | intensify |

- **Sizes** — `sm` (0.62rem signage, dense instrument rows), `md` (0.72rem, default). No `lg`; the
  language is dense, not chunky.
- **States** — `:hover` (hue tint, never a fill swap), `:focus-visible` (`.viz-focusable` ember ring),
  `:disabled` (`opacity: 0.5; cursor: default`), and a **busy/dispatching** state that applies the
  `viz-breathe` ember pulse (opacity-only) to signal in-flight work (e.g. `.rdesk-run` while dispatching).
- **Motion** — hue transitions over `--viz-dur-state`; busy uses `--viz-dur-breathe`. Reduced-motion:
  both become instant (busy still reads via the ember hue + a static label, no pulse).
- **A11y** — a real `<button>`; label is the accessible name (icon-only buttons require `aria-label`);
  ember focus ring meets ≥3:1 against ground; hit target ≥ the row height with adequate padding; the
  `danger` hue is **never the sole signal** (verb-explicit label, e.g. "Delete", + oxide border).
- **Distinctiveness** — uppercase signage caps + flat ruled border + ember-on-hover is the instrument
  tell; it is explicitly **not** the filled-indigo pill of the generic AI app.

## 4. Primitive: **SegmentedControl**

A **spatial exposure/choice scale** — a row of mutually-exclusive segments where position *means*
something (more-exposed → further along; off → on). Replaces native `<select>` for small bounded
enumerations **and** promotes the two inline instances already shipped on The Field Desk: the
**clearance ladder** (`.rdesk-ladder` / `.rdesk-rung`) and the **config segments** (`.rdesk-seg` /
`.rdesk-seg-opt`). This is the textbook "reused by a 2nd surface → hoist to shared" boundary call.

**Anatomy** — an inline-flex `role="radiogroup"` of ghosted segments (`role="radio"` /
`aria-checked`), 2px gaps, 1px `--viz-rule` borders, **zero radius** (a ruled register, not a pill
toggle). The active segment fills; the rest stay ghosted (`--viz-idle` label).

**Variants:**

| Variant | Active fill | Semantics |
| --- | --- | --- |
| `neutral` | `--viz-rule` fill, `--viz-ink` label | a plain bounded choice (schedule cadence, autonomy) — steering, not risky |
| `clearance` | the **temperature** of the active rung (`patina` → `brass` → `ember`) | egress exposure — the ladder; hue = consequence |

- **Ordering is meaningful** — segments read left→right as least→most (exposure, frequency,
  autonomy). The active fill is a *position on a scale*, not a highlighted menu item.
- **States** — resting (ghosted), `aria-checked` (filled in variant hue), `:hover` non-active
  (`--viz-ink-muted` border + ink label), `:focus-visible` (ember ring), disabled group dims to 0.5.
- **Motion** — the fill crossfades over `--viz-dur-state`; reduced-motion → instant.
- **A11y** — proper `radiogroup`/`radio` semantics with roving tabindex and arrow-key traversal; a
  visible **signage label** precedes the group (`.rdesk-*-label` pattern); the active state reads via
  fill **and** the checked semantics, never hue alone; in `clearance` variant the hue is reinforced by
  position + label so a low-vision/colorblind user still reads the exposure level.
- **Why not a `<select>`** — a dropdown hides the scale behind a click and renders the generic UA
  control; the segmented register keeps **posture legible at rest** (you see the whole ladder and where
  you are on it) — a core Field-Desk principle, and the reason `<select>` is banned on these surfaces.

## 5. Primitive: **ConfirmInline + Dialog**

The **consequence-gate** primitive — a deliberate "are you sure" for irreversible / egress-starting
actions. Two presentations of one model. Promotes `.confirm` (Settings replay), `.rdesk-confirm`
(arm/run/widen-clearance), and absorbs the WS1 confirm-box fix (#215: dismissable, honest wording).

**Model** — a consequence-worded message + a confirm action (`danger` or `clearance-tinted` Button) +
a dismiss (`ghost` Button). The message states **what will happen** in plain language ("This starts
egress to the public web"), never a bare "Confirm?".

**Variants:**

| Variant | Presentation | Use |
| --- | --- | --- |
| `inline` | expands **in place** beneath the triggering control, framed by a left **2px hue rule** (brass = caution, oxide = destructive). No overlay. | the default — keeps context, no modal trap (Field Desk arm/run; #215) |
| `dialog` | **not yet implemented — inline `.viz-confirm` is the shipped form**; a centered overlay on a scrim, same internals | lands when a real flow has no inline anchor / must block all other interaction (rare) |

- **Dismissal (a11y + #215)** — inline: `Esc` collapses it and returns focus to the trigger; dialog:
  `Esc` + scrim-click close, focus is **trapped** while open and **restored** to the trigger on close.
  An open confirm must always be dismissable without committing (the #215 bug was a confirm you
  couldn't back out of).
- **Wording (honesty rule)** — the message names the real consequence and the real state ("Runs on
  demand — not paused", #215). No dev jargon, no synthetic copy (QA gate).
- **Hue** — `brass` for caution (reversible-but-notable), `oxide` border for destructive; per the
  contract (§2) the hue is on the **rule/border + the confirm button border**, the message text stays
  `--viz-ink`.
- **Motion** — inline expand over `--viz-dur-state`; dialog fades the scrim over `--viz-dur-state`;
  reduced-motion → instant appear. No slide/bounce.
- **A11y** — dialog is `role="dialog"` `aria-modal="true"` with a labelled heading; focus moves to the
  confirm on open; inline variant is an `aria-live="polite"` region so the consequence is announced.
- **Distinctiveness** — the default is an **inline, hue-ruled consequence-gate that expands in place**,
  not a generic centered modal-over-scrim (and never the native `confirm()` dialog). The consequence is
  worded and the gate stays in the flow of the control it guards — the opposite of the AI-app habit of a
  rounded card popping over a dimmed app for every confirm.

## 6. Primitive: **EditableField**

The **inline value editor** — a labelled, in-place editable value that reads as a *legible setting at
rest* and edits without a modal. Promotes `.rdesk-prompt` (textarea), `.rdesk-input` / `.rdesk-field`
(text/numeric), and the **EFFORT** numeric (`maxToolCalls`, #208). Replaces legacy `.field input` /
`textarea.capture`. **This is the primitive WS3's researcher config editors are built on.**

**Anatomy** — a small **signage label** above/beside the value; the value in the role-appropriate face
(**numeric → `--viz-font-numeric` tabular**, text → body); a **bottom-rule** affordance
(`border-bottom: 1px --viz-rule`, no boxed input chrome) that lights ember on focus; an optional unit
caption (e.g. `calls / pass`) and an inline save (`primary` Button, appears on dirty).

**Types:**

| Type | Editor | Notes |
| --- | --- | --- |
| `text` | single-line, bottom-rule input | names, repo, tenant |
| `numeric` | tabular-mono input, `min`/`max`/`step`, stepper-free | **EFFORT** (#208): default 15, bounded ≥1, under the global per-Instance ceiling |
| `multiline` | auto/▼-growing textarea (the standing-orders box) | the substantive prompt |
| `duration` | numeric + unit caption | WS3: researcher session timeout (RESEARCH-18) |

- **The axis-coloring rule (carried from #208)** — an EditableField that is **steering** (effort,
  schedule, scope, timeout — *how it works*) lives in **neutral `--viz-ink`** and saves with **no
  consequence-confirm**. It is **never** painted in a clearance/state hue, so a steering dial is never
  misread as an egress/safety control. (Risky changes are a Button + ConfirmInline, not a field.)
- **States** — resting (value legible, rule at `--viz-rule`), `:focus-within` (ember bottom-rule),
  dirty (save Button appears), saving (save Button busy-breathes), invalid (oxide **bottom-rule** +
  message; text stays ink — contract §2), disabled (0.5).
- **Validation** — bounds enforced inline (numeric `min`/`max`); the invalid state shows the reason,
  reachably (`aria-describedby`), and blocks save.
- **Motion** — focus rule + save reveal over `--viz-dur-state`; reduced-motion → instant.
- **A11y** — a real labelled form control (`<label for>` / wrapping label, not a loose input); the unit
  caption is associated via `aria-describedby`; numeric uses `inputmode="numeric"`; focus order is
  natural; the bottom-rule focus state is reinforced by the ember `.viz-focusable` ring (not rule-only).
- **Distinctiveness** — a value that **reads as a legible setting at rest and edits in place on a single
  bottom-rule**, not a boxed input sitting in a generic settings row/card. No filled input wells, no
  framework form chrome; the rule lights ember on focus. The setting *is* the readout — you see the value
  spatially (signage label + tabular figures) without opening a form.

## 7. The composition boundary (shared vs surface)

Per `design-system.css`'s own boundary rule: **reused by a 2nd surface → it belongs in the shared kit;
this-view-only composition → it stays in the surface file.** These four primitives + the token/type/
motion floor are the shared kit. Surface-specific *assemblies* — the refinery carriages, the
researcher strip layout, the clearance **ladder's labelling**, gauge rails — compose the primitives but
**stay in their surface files** (`theLine.css`, the researchers view). A primitive must not encode any
one surface's layout.

## 8. Migration map (the WS2 → migration PRs the kit unblocks)

The kit's value is realized when surfaces drop bespoke/legacy controls for it. Targets, in priority:

| Surface | Today | Migrates to |
| --- | --- | --- |
| **Researchers / The Field Desk** | already instrument-language, but controls are inline (`.rdesk-arm/-rung/-seg-opt/-input/-confirm`) | hoist those into the shared primitives (least risk — same look, one source of truth) |
| **Jobs** (SPEC-0027) | legacy `.btn`, `.job-controls select`, `.confirm` | Button + SegmentedControl (cadence) + ConfirmInline |
| **Reviews** (SPEC-0018) | legacy `.review-reject`, `button.primary`, `textarea.review-note` | Button (default/primary) + EditableField (multiline note) |
| **Control Panel / Settings / Sources** | `.autonomy-row select`, `.btn-danger`, `.field input` | SegmentedControl (autonomy) + Button (danger) + EditableField |

Each migration is a **WS2-blessed-primitive consumer**: per the Principal HYBRID test policy, the
**e2e visual snapshot is authored once when each primitive lands** (against this spec's canonical
form), and migration PRs **reuse** that snapshot — no per-PR regression boilerplate. The blessed
primitive + its reference snapshot land together (design sign-off → snapshot → migrations).

## 9. Key user flows covered (for GATE 2 / KB-QD)

The kit is correct only if the migrating surfaces' real flows still work. The primitives map to these
flows (the same flows the per-surface specs already gate):

1. **Arm / run / widen a researcher** — Button (clearance-tinted) + ConfirmInline (consequence) +
   SegmentedControl (clearance ladder). (SPEC-0028)
2. **Configure effort / schedule / autonomy / timeout** — EditableField (numeric/duration, neutral) +
   SegmentedControl (neutral). (SPEC-0028 / WS3)
3. **Enable/disable a job + pick a cadence** — Button + SegmentedControl. (SPEC-0027)
4. **Answer a review (accept / reject with a note)** — Button (default/primary) + EditableField
   (multiline). (SPEC-0018)
5. **Confirm a destructive/irreversible action anywhere** — ConfirmInline/Dialog, dismissable (#215).

Each primitive's a11y contract (keyboard, focus, non-color-only state) is part of what GATE 2 verifies.

## 10. Out of scope / deferred

- **Migrating the surfaces** — downstream WS2 dev + the per-surface migration PRs (§8); this spec is the
  primitive definitions + a11y contract they build to.
- **New primitives beyond the four** — Tooltip, Toast, Tabs, Menu, Table emerge later **as a 2nd
  surface needs them** (DESIGN-7's "emerges over time" still governs primitive #5+). Don't pre-build.
- **The legacy token retirement** — sunsetting `--bg/--card/--accent` entirely is a cleanup tracked
  against the migration completing, not a precondition of landing the kit.
- **Icon set / glyph library** — the leading glyphs are referenced, not specified here.

## 11. Open questions

- [ ] **Primitive home in code** — one `design-system.css` grown with the primitives, or a
      `primitives/` split per component? (Dev call; the spec is presentation-agnostic.)
- [ ] **`<select>` total ban vs. SegmentedControl threshold** — at what option count does a bounded
      enum stop being a SegmentedControl and become a searchable list? (Propose: > ~6 options → a
      different primitive, authored when first needed.)
- [ ] **Snapshot authority** — confirm KB-QD authors the one-time e2e snapshot off the *blessed*
      primitive (post-gate), so it can't bake in a pre-sign-off form.

## 12. Changelog

- 2026-06-06 — created (draft). WS2 of the Principal app-review: promotes **Button · SegmentedControl ·
  ConfirmInline+Dialog · EditableField** from surface-inline/legacy-fragmented into one **canonical
  shared kit** in "The Line" instrument language, built on the existing `design-system.css` token/type/
  motion floor (§2) and its contrast contract. Documents anatomy · variants · states · tokens · motion +
  reduced-motion · a11y · distinctiveness per primitive, the shared/surface boundary (§7), the migration
  map (§8), and the flows GATE 2 covers (§9). **WS2 gates WS3** (researcher editors compose
  EditableField + SegmentedControl). Awaiting GATE 1 (AI-Detector) + GATE 2 (KB-QD) before `active`.
- 2026-06-06 — **both gates cleared → `active`** (merged as #223). GATE 1 (KB-AI-Detector) passed with a
  strong distinctiveness verdict ("strongest anti-generic artifact in the corpus"); GATE 2 (KB-QD)
  cleared on merge. Implemented in **#225** (the four primitives hoisted into `design-system.css` +
  Researchers migrated), then consumed by **#226** (WS3 editable budget/timeout on EditableField,
  closing RESEARCH-15/18) and **#227** (Reviews migrated onto Button + EditableField).
- 2026-06-06 — **gate-1 nit + design sign-off** (follow-up): added the labelled **distinctiveness** line
  to ConfirmInline (§5) and EditableField (§6) for parity with Button/SegmentedControl (KB-AI-Detector
  non-blocking note). **Retroactive Design-Lead sign-off of the #225 implementation: PASS** — the
  `.viz-btn--*`, `.viz-seg-opt(--clearance)`, `.viz-confirm`, `.viz-field__*` classes are faithful to
  this spec, honor the §2 contrast contract + the #208 axis rule, and even caught the #215 hidden-
  dismissability edge. **Deferred-to-surface (not drift):** the Confirm **`dialog`** variant and an
  explicit **`clearance-tinted` Button** modifier are surface-composed for now; promote to the shared
  layer when a 2nd surface needs them.
