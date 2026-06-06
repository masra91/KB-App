---
design: DESIGN-SHOWCASE
implements: SPEC-0033
title: Design-System Showcase — the primitive gallery & visual-snapshot home
type: design
status: draft   # visual content ready ahead of dispatch; PM dispatches the executor (snapshot wiring) when prioritized
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0033, _design-system, SPEC-0028, SPEC-0032]
gates:
  ai-patterns: n/a          # internal dev/reference surface, not user-facing app chrome (DESIGN-8) — distinctiveness rides on _design-system
  qa-flow-coverage: pending # GATE 2 — KB-QD: the gallery renders every blessed primitive × variant × state for the snapshot
stage: Cross-cutting
---

# Design-System Showcase — the primitive gallery & visual-snapshot home

> A **static, copilot-free, pipeline-free** view that renders every blessed WS2 primitive in **all its
> variants and states** on one page. Two jobs: (1) the **living design reference** for the team (you can
> see the canonical kit without spelunking feature surfaces), and (2) the **home for the HYBRID e2e
> visual snapshot** — one `toHaveScreenshot()` against this page pins the primitives directly, instead
> of fragile indirect snapshots through `active`-gated feature surfaces (#233, parked 2026-06-06).
>
> This spec is the **visual content** (what the gallery renders + how it's laid out); **an executor
> wires the view + the snapshot** (KB-Lead/PM ruling 2026-06-06). It composes the primitives defined in
> [`_design-system.md`](./_design-system.md) — it adds **no new visual language**, only renders the
> existing one exhaustively.

## 1. Why this exists (the re-home)

The HYBRID policy (SPEC-0033 §6 / DESIGN-9) says blessed primitives get a **one-time e2e visual
snapshot**. The first attempt (#233) snapshotted the primitives *indirectly* through the Researchers/
Jobs surfaces — but those only render with `active` (git + pipeline), so the snapshot needed a heavy
harness and failed in CI. KB-Lead parked it and re-homed the mandate here: a **dedicated component
gallery with no pipeline dependency** makes the snapshot trivial and genuinely reusable — the
storybook-style way component visual-regression *should* be done.

**Non-gating, not urgent:** the primitives are already protected by composition + a11y **unit** tests;
this snapshot is the additional visual guard, dispatched when prioritized. The #235 `update_snapshots`
ci.yml dispatch infra already exists and is reused as-is for this page's snapshot.

## 2. Surface (what the executor renders)

A single scrollable route — internal/dev (reachable via a dev affordance or a `?showcase` flag; **not**
in the user nav, **no** copilot/IPC/pipeline calls). Built on `.viz-surface` so it inherits the
instrument ground, type roles, and the reduced-motion reset.

Layout: **one labelled section per primitive**, each a small grid of **every variant × every
state**, each cell tagged with a mono caption naming the variant+state it shows (so a snapshot diff
points at the exact cell). Render **both themes** — the page shows dark and light side-by-side (or a
toggle the snapshot captures in both), since the tokens have a `prefers-color-scheme` light override
that must stay covered.

## 3. The render matrix (the canonical coverage the snapshot pins)

Every cell below is a required render. States that are interaction-only (`:hover`, `:focus-visible`,
busy) are forced via a class/data-attr the executor toggles, so they're captured statically.

**Button** (§3 of `_design-system.md`) — variants × states:
- variants: `default · primary · danger · ghost · clearance-tinted(patina|brass|ember)`
- states per variant: `resting · hover · focus-visible · disabled` · plus `busy` (default+primary) · sizes `sm` and `md`

**SegmentedControl** (§4):
- `neutral`: 3-segment group — each segment `resting(ghosted) · active · hover · focus-visible`; whole group `disabled`
- `clearance`: the ladder — active rung at each temperature `local-only(patina) · internal-tenant(brass) · public-web(ember)`

**ConfirmInline + Dialog** (§5):
- `inline` caution (brass rule) · `inline` danger (oxide rule) — message + confirm Button + dismiss Button
- `inline` **dismissed/hidden** (proves the `[hidden]{display:none}` contract from #215)
- `dialog` variant (overlay on scrim) — open state

**EditableField** (§6):
- types: `text · numeric(tabular, EFFORT) · multiline · duration`
- states per type: `resting · focus-within(ember rule) · dirty(save shown) · invalid(oxide rule, ink text) · disabled`

## 4. Guardrails (so the gallery stays a faithful mirror)

- **No new CSS classes for the primitives** — the gallery uses the exact `.viz-btn--*`, `.viz-seg-opt`,
  `.viz-confirm`, `.viz-field__*` classes from `design-system.css`. If a cell can't be rendered with the
  shipped classes, that's a **gap in the primitive**, not a reason to add showcase-only styling.
- **Static only** — no live data, no pipeline, no copilot. States are toggled by class/attr, not by
  real interaction or async work, so the page is deterministic for a snapshot.
- **Both themes + reduced-motion** — the snapshot must cover the light override; a reduced-motion pass
  is acceptable as a second snapshot or by asserting the reset zeroes the `busy` pulse.
- **Caption every cell** — `--viz-font-numeric` mono caption naming variant+state, so a future diff is
  legible ("Button/danger/hover changed") rather than "something moved."

## 5. Key flows covered (GATE 2 / KB-QD)

This surface has one "flow": **a maintainer (or the snapshot) can see every blessed primitive in every
documented state on one deterministic page.** GATE 2 verifies the matrix in §3 is fully rendered (no
primitive/variant/state missing) and the snapshot is green against it. No AI-distinctiveness gate —
this is internal tooling, not user-facing chrome (SPEC-0033 DESIGN-8); distinctiveness already rode the
`_design-system.md` gate.

## 6. Out of scope

- **The snapshot wiring + CI** — the executor's job (reuses #235's `update_snapshots` dispatch).
- **Any new primitive** — this only renders the existing four; a 5th primitive emerges per DESIGN-7 and
  would add its own section here when it lands.
- **A user-facing "design" page** — this is a dev/reference surface, not a product feature.

## 7. Open questions

- [ ] **Reachability** — dev-menu item vs `?showcase` query flag vs a separate dev entry HTML? (Executor/
      DEV call; must stay out of the user nav.)
- [ ] **Theme capture** — side-by-side dark+light on one page (one snapshot) vs two snapshots via a
      forced `color-scheme`? (KB-QD's call on the snapshot mechanics.)

## 8. Changelog

- 2026-06-06 — created (draft). Re-homes the HYBRID e2e visual-snapshot mandate (SPEC-0033 §6/DESIGN-9)
  from the parked #233 (indirect, `active`-gated feature-surface snapshots) onto a **static copilot-free
  primitive-showcase gallery** (KB-Lead/PM ruling). Defines the render matrix (every blessed primitive ×
  variant × state, both themes), the faithful-mirror guardrails, and the GATE-2 coverage. Visual content
  authored ahead of dispatch; executor wires the view + snapshot when PM prioritizes. Reuses #235 infra.
