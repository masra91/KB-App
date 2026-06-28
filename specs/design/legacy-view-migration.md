---
design: DESIGN-LEGACY-VIEWS
implements: SPEC-0033
title: Legacy never-gated views — WS3 migration design spec (Activity · Settings · Agents · Ask · Capture)
type: design
status: implemented   # all 5 view targets + the a11y sweep shipped on main (see §10); HYBRID gate, KB-Lead classifies
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-08
updated: 2026-06-27
related: [SPEC-0033, SPEC-0027, SPEC-0029, SPEC-0028]
design-system: ../../app/src/shell/design-system.css   # "The Line" — the blessed WS2 primitives/tokens
gates:
  ai-patterns: n/a            # no net-new surfaces — this is a migration of existing views onto blessed primitives
  qa-flow-coverage: pending   # KB-Lead classify per the HYBRID policy; KB-QD code gate-2 at each impl PR
---

## 1. Purpose

Five views predate the WS2 design-system ("The Line") and were never gated, so each carries one or more
**off-system** primitives — native OS controls, hard-coded hex, and pre-WS2 button/confirm classes that
drift from the graphite/ember language and skip the a11y baseline. This spec is the **migration target**
for each: the exact blessed primitive every off-system element maps to, plus the a11y additions, so a dev
can wire the migration and **KB-Lead can gate it against a written spec** (HYBRID policy — a token/structural
migration onto existing primitives, not a net-new surface).

**Scope:** this spec defines the *visual + a11y target*. Implementation wiring is dev work dispatched
against it (PM-routed). Every element maps to a primitive that **already exists** in `design-system.css`
— no new tokens, no new components (DESIGN-7 coherence). Where a behavior changes (e.g. a `<select>`
becomes a SegmentedControl), the spec calls out the interaction so KB-QD can gate the logic.

**Blessed primitives referenced** (all live in `app/src/shell/design-system.css`):
`.viz-seg` / `.viz-seg-opt` (SegmentedControl) · `.viz-btn` / `.viz-btn--primary` / `.viz-btn--danger` ·
`.viz-field` / `.viz-field__input` / `.viz-field__label` · `.viz-chip` · state tokens
`.viz-state-running` (`--viz-ember`) / `.viz-state-blocked` (`--viz-brass`) / `.viz-state-error`
(`--viz-oxide`) / `--viz-idle`.

---

## 2. Activity view (`activityView.ts` · `index.css §5`)

**State:** the most WS2-adjacent of the five (already theme-native via the `--border`/`--card` shims).

| Defect | file:line | Migration target |
| --- | --- | --- |
| **P1 — "trace origin" off-center** (orphan `<li>` child, flush-left, outside the head's padded content) | `activityView.ts:182-198`, `index.css:631-643` | ✅ **Fixed in PR #261** — toggle + trace share a `.activity-entry-row` flex row (head `flex:1`+`min-width:0`, trace right-inset `0.7rem`, both centered). Pattern below is the canon for this view. |
| Actor filter is a native `<select>` (`#activityActor`) | `activityView.ts:151` | → **SegmentedControl** (`.viz-seg`) **only if** the actor set is small/stable; the actor universe is data-derived and can be long, so a `<select>` is acceptable here **provided** it carries `.viz-field__input` styling + its existing `aria-label`. Document the threshold: ≤4 stable options → segmented; open/long set → styled select. |

**Canonical pattern (set by P1):** a per-entry **trailing action** sits in the shared header row, right-inset
to match the row padding, vertically centered with the primary control — never an orphan block. Reuse for any
future per-entry action.

**A11y:** `trace origin` button — add `aria-label="Trace the origin of: <summary>"` (the bare visible label
"trace origin" is ambiguous to a screen reader out of row context). Filter `<select>`/search already labeled.

---

## 3. Settings view (`settingsView.ts` · `index.css`)

| Defect | file:line | Migration target |
| --- | --- | --- |
| Native `<select id="autonomy-default">` (Guarded / Autonomous) | `settingsView.ts:70` | → **SegmentedControl** `.viz-seg` / `.viz-seg-opt` (2 stable options, the textbook segmented case; `aria-checked` per option, roving focus). |
| Native `<select id="devlog-level">` (Info / Debug) | `settingsView.ts:83` | → **SegmentedControl** `.viz-seg` (2 stable options). |
| Pre-WS2 confirm blocks `class="confirm"` (autonomy + replay) | `settingsView.ts:72, 91`; `index.css:471` | → **`.viz-confirm`** (the blessed inline-confirm; `--viz-brass` left-rule for a normal confirm, **`.viz-confirm--danger`** `--viz-oxide` rule for the destructive "Clean & Rebuild"). |
| `class="btn"` Cancel buttons | `settingsView.ts:74, 93`; `index.css:477` | → **`.viz-btn`** (ghost/neutral). |
| `class="btn-danger"` (Set Autonomous, Clean & Rebuild) | `settingsView.ts:75, 90, 94`; `index.css:479` | → **`.viz-btn--danger`** (`--viz-oxide` border; the destructive emphasis). |

**Interaction note (KB-QD gate-2):** the `<select>`→SegmentedControl swaps a `change` event for a
`click`/`aria-checked` toggle — the autonomy-confirm gating logic (guarded↔autonomous) must re-wire to the
segmented option, not the removed select. The **danger** semantic stays: Set-Autonomous and Clean-&-Rebuild
keep oxide; the confirm step is preserved.

**A11y:** SegmentedControls expose `role="radiogroup"` + `aria-checked`; each control gets a
`.viz-field__label` (uppercase signage) naming it.

---

## 4. Agents view (`agentsView.ts` · `index.css §agent-status`)

| Defect | file:line | Migration target |
| --- | --- | --- |
| **Hard-coded hex** `#7ad17a` for the running status | `index.css:488` (`.agent-status.status-running`) | → **`--viz-state-running`** (`= --viz-ember`). Map the whole `status-*` family to the state tokens: **running → `--viz-ember`**, idle → `--viz-idle`, blocked → `--viz-brass`, error → `--viz-oxide`. Drop the bespoke `#2f5c2f` border for the token-driven equivalent. |

**Coherence:** the status chip is rendered as `agent-status status-${status}` (`agentsView.ts:48,70`) — the
class plumbing already exists; this is a **pure token swap** in CSS, no markup change. State must never be
color-alone — the status **text label** ("running"/"idle"/…) carries the meaning, so the token swap is safe.

**A11y:** none new (text label present). Optionally give the status chip `.viz-chip` styling for shape
consistency with the rest of the system.

---

## 5. Ask view (`askView.ts` · `index.css`)

| Defect | file:line | Migration target |
| --- | --- | --- |
| `class="primary"` on the Ask submit button | `askView.ts:65`; `index.css:79` (`button.primary`) | → **`.viz-btn--primary`** (the one emphasized action; ember-on-hover). |
| Rendered markdown answer can overflow on long unbroken tokens (URLs, hashes) | `askView.ts:21` (`renderMarkdown`) | Add **`word-break`/`overflow-wrap: anywhere`** on the answer container so long citations/URLs wrap instead of forcing horizontal scroll. (Render path already sanitizes via marked+DOMPurify — no content change, CSS only.) |

**A11y:** the inline `[n]` citation markers are anchors with **no `href`** (`askView.ts:27-29`) — they must
carry `role="link"` + an `aria-label` naming the source (e.g. `aria-label="Citation 1: <source title>"`),
and be keyboard-activable (Enter/Space), since they open an `obsidian://` deep-link via a delegated handler
rather than native navigation.

---

## 6. Capture view (`captureView.ts` · `index.css`)

| Defect | file:line | Migration target |
| --- | --- | --- |
| `class="primary"` Capture button | `captureView.ts:213`; `index.css:79` | → **`.viz-btn--primary`**. |
| Capture `<textarea class="capture">` is unlabeled (placeholder-only) | `captureView.ts:207` | → wrap in a **`.viz-field`** with a visible/SR `.viz-field__label` ("Capture"); `.viz-field__input--multiline`. Placeholder is not an accessible name. |
| Dropzone `<div class="dropzone">` is not an announced region | `captureView.ts:210`; `index.css:168` | Add **`role="button"` (or `region`) + `aria-label="Drop files here to capture them"`** and `tabindex="0"` so it's reachable/announced; keep the visible drop affordance. |
| "Keep formatting on paste" checkbox label | `captureView.ts:209` | Acceptable (native checkbox + `<label>` wrap is already accessible); restyle the `.toggle` to the WS2 muted-signage label for consistency. |

**A11y is the headline here:** Capture is a primary input surface with **no field label and an
un-announced dropzone** — both block screen-reader use. The textarea label + dropzone `aria-label` are the
load-bearing fixes.

---

## 7. A11y sweep plan (cross-view)

A single checklist a dev can verify (and KB-QD can gate) across the five views:

| Surface | Add | Why |
| --- | --- | --- |
| Activity `trace origin` button (§2) | `aria-label="Trace the origin of: <summary>"` | "trace origin" alone is ambiguous out of row context |
| Activity actor filter / search | already labeled — **verify** | regression guard |
| Settings SegmentedControls (§3) | `role="radiogroup"` + per-option `aria-checked` + `.viz-field__label` | radio semantics for the new control |
| Agents status chip (§4) | none (text label present) — **verify not color-alone** | state must not rely on color |
| Ask citation links (§5) | `role="link"` + `aria-label="Citation n: <source>"` + keyboard activation | href-less anchors are invisible to AT/keyboard |
| Capture textarea (§6) | `.viz-field__label` accessible name | placeholder ≠ label |
| Capture dropzone (§6) | `role` + `aria-label` + `tabindex="0"` | un-announced, unreachable region |

**Verification:** each migration PR runs the existing per-view component tests (happy-dom) asserting the new
primitive/ARIA is present (fails-before/passes-after), plus a manual VoiceOver pass on Capture + Ask (the two
input-heavy surfaces).

---

## 8. Out of scope
- New tokens / new components — every target already exists in `design-system.css`.
- Behavior/feature changes beyond the control-type swaps called out in §3 (logic) — those are separate specs.
- The already-migrated WS2 views (Researchers / Reviews / Jobs / Sources) — untouched.

## 9. Decisions (rationale → `decisions`)
- **One migration spec, per-view sections** — the views share the same target language (The Line) and the
  same gate (HYBRID, KB-Lead classify); a single doc keeps the mapping coherent and reviewable, and a dev
  picks up a view by its section. Each section is self-contained (defect → target → a11y).
- **`<select>`→SegmentedControl only for small/stable option sets** (Settings autonomy/devlog: yes; Activity
  actor universe: keep a styled select — it's data-derived and can be long). The control follows the data
  shape, not a blanket rule.
- **Status colors are tokens, never hex** — `#7ad17a` → `--viz-state-running`; a hard-coded hex can't theme
  and drifts from the state semantic (running = ember, blocked = brass, error = oxide). State carries a text
  label too (never color-alone).
- **A11y is part of the migration, not a follow-up** — placeholder-as-label and un-announced dropzones are
  the highest-severity gaps (Capture); they ship with the view's migration PR.

## 10. Changelog
- 2026-06-27 — **status → implemented (record-squaring).** On reconciliation against the committed tree, every
  target in §§2–7 is already on `main` (shipped across the WS3 wave #261/#262/#274/#285): Settings
  selects→`.viz-seg` + `.viz-confirm`/`.viz-btn--danger`; Agents `status-*`→`--viz-state-*` tokens (hex gone);
  Ask `.viz-btn--primary` + citation `role="link"`/`aria-label`/keyboard + `.ask-answer{overflow-wrap:anywhere}`;
  Capture `.viz-field` textarea label + dropzone `role`/`aria-label`/`tabindex` + `.viz-btn--primary`; Activity
  styled-select actor filter (spec-acceptable for the data-derived set) + centered trace (#261) + trace-by-id
  lookup (#386). The §7 a11y sweep items are all present. No further migration PR needed; the `gates:` block
  is left for KB-Lead's HYBRID classify (rubber-stamp). File:lines in §§2–6 are the 06-08 snapshot and have
  since drifted (Settings grew Scale/Recall cards) — read them as intent, not current line numbers.
- 2026-06-08 — created (draft). WS3 Principal deep-pass: migration target for the 5 legacy never-gated views
  onto the blessed WS2 primitives + an a11y sweep, so future migration is gated against a written spec.
  Defects + file:lines self-sourced from the tree; will fold in KB-Lead's full WS3 evidence when it lands.
  P1 (Activity trace-origin centering) already shipped as PR #261. Pending KB-Lead classify (HYBRID).
