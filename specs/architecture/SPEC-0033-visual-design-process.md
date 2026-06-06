---
spec: SPEC-0033
key: DESIGN
title: Visual Design Language & Process (parallel, gated, checked-in)
type: architecture
status: draft
owners: [KB-Lead, Visual-Design-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0000, SPEC-0003, SPEC-0011, SPEC-0012, SPEC-0017, SPEC-0032]
stage: Cross-cutting
supersedes: null
---

# Visual Design Language & Process (parallel, gated, checked-in)

> The app is starting a deliberate visual-polish push toward a **distinct identity** (not a
> generic AI app). This spec defines **how visual design work is done, gated, and captured** —
> so design is a **first-class, parallel, governed** workstream and the visual language is a
> **checked-in living artifact**, not tribal or ad-hoc.

## 1. Intent (the why / JTBD)

Visual polish has been deferred while the machine got built. Now the Principal is adding a
**Visual-Design-Lead** and pushing on polish — but polish without process drifts (inconsistent
surfaces, the generic-AI look, designs that look nice but miss user flows). This spec makes
design **run in parallel**, pass **two gates** (distinctiveness + functional coverage), and land
as **specs** — same living-spec discipline as everything else (SPEC-0000).

## 2. The workflow

```
Product Lead names a surface needing design (intent + key user flows)
        │
        ▼
Visual-Design-Lead authors the design  (runs IN PARALLEL with feature dev — PM-enabled)
   structure · color · theme · typography · motion · visual language
        │
        ├── GATE 1 — AI-patterns detector  → must APPROVE: visually DISTINCT, not the generic
        │                                     AI-app look (chat/cards/purple-gradient/etc.)
        │
        └── GATE 2 — QA agent  → must VERIFY: the design clearly implements the functionality
                                  for ALL key user flows of the surface
        │
        ▼
Checked in as a living DESIGN spec (markdown; images/diagrams optional)
   documents structure, colors, themes, typography, motion, visual language
```

## 3. Roles

- **Product Lead (KB-Lead)** — names which surfaces need design + the product intent / key flows.
- **Visual-Design-Lead** — authors the visual design per surface.
- **AI-patterns detector** — the **distinctiveness gate** (a reusable rubric/check).
- **QA agent (KB-Quality-Driver)** — the **functional-coverage gate** (key user flows).
- **PM** — runs design as a **parallel stream**; coordinates the gates and check-in.

## 4. Requirements

| ID       | Priority | Statement (short)                                                                  | Verify   | Traces |
| -------- | -------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| DESIGN-1 | must     | Visual design is a **first-class, parallel workstream** — it runs alongside feature dev (PM-enabled), **not a serial bottleneck** | none-yet | SPECSYS |
| DESIGN-2 | must     | The **Visual-Design-Lead authors** each surface's design — **structure, color, theme, typography, motion, visual language** | none-yet | VISION-13 |
| DESIGN-3 | must     | A design **must be approved by the AI-patterns detector** before it lands — **visually distinct**, not the generic AI-app look | none-yet | VIZ-8; VISION-13 |
| DESIGN-4 | must     | A design **must be QA-verified** — a QA agent confirms it **clearly implements the functionality for all key user flows** of the surface | none-yet | TEST-2; VISION-13 |
| DESIGN-5 | must     | Approved designs are **checked in as living specs** (markdown) documenting **structure / colors / themes / typography / motion / visual language**; **images/diagrams optional** (allowed, not required) | none-yet | SPECSYS-7 |
| DESIGN-6 | should   | The **AI-patterns detector owns + authors its own rubric** (delegated, not prescribed here) — grounded in its baked knowledge **plus research of current AI-app visual conventions** (online trends), scoped to a **simple Electron desktop app**. A reusable per-design check that flags drift into the generic AI look | none-yet | VIZ-8 |
| DESIGN-7 | should   | The visual language is **coherent across surfaces** — a shared design system emerges from the per-surface design specs over time | none-yet | PRIN-17,18 |
| DESIGN-8 | must     | The detector governs the **app's UI surface/chrome ONLY** — **AI-generated KB _content_ is fine** (the knowledge can be AI; the *app* just shouldn't *look* generically AI). The concern is the product's visual identity, not the vault's contents | none-yet | VISION-12,13 |

## 5. The design spec (what a checked-in design documents)

A design spec (one per surface, e.g. `specs/design/<surface>.md`) documents:
- **Structure / layout** — regions, hierarchy, responsive behavior.
- **Color & theme** — palette, dark/light, semantic roles (state, emphasis).
- **Typography** — type scale, weights, usage.
- **Motion** — what animates, when, and the **reduced-motion** behavior.
- **Visual language** — the distinctive elements that make it *this app*.
- **Key user flows covered** — the flows the QA gate verified.
- *(Optional)* mockups / ASCII / diagrams — allowed, not required.

## 6. Out of scope (for now)

- **A specific surface's design** — those are the per-surface design specs (the **first is
  SPEC-0032 Pipeline Visualization**).
- **Implementation / component library** — dev work downstream of the design spec.
- **The AI-patterns-detector internals** — its rubric is defined separately (DESIGN-6).

## 7. Open questions

- [ ] **Where design specs live** — `specs/design/<surface>.md`? Confirm the folder.
- [x] **AI-patterns-detector rubric** — RESOLVED: **the detector authors its own** (DESIGN-6),
      researching current AI-app visual conventions; scope is the **app UI surface, not KB
      content** (DESIGN-8).
- [ ] **QA "key user flows" coverage** — how the gate enumerates + verifies flows per surface.
- [ ] **Gate ordering / blocking** — both gates must pass to land; who arbitrates a tie/conflict
      (Product Lead on intent, Principal on identity).

## 8. Changelog

- 2026-06-02 — created (draft). Stands up the **visual-design workflow**: design runs **in
  parallel** (PM-enabled), authored by the **Visual-Design-Lead**, gated by the **AI-patterns
  detector** (distinctiveness — not generic AI) **and** a **QA agent** (functional coverage of
  all key user flows), then **checked in as living design specs** (structure/colors/themes/
  typography/motion/visual language; images optional). First surface: SPEC-0032 (Pipeline
  Visualization). Principal direction as the visual-polish push begins.
- 2026-06-06 — **DESIGN-7 shared system now authored deliberately** (WS2 of the Principal
  app-review). After two surfaces (SPEC-0032 "The Line", SPEC-0028 "The Field Desk") proved the
  instrument language, the shared design system stops *only emerging* (DESIGN-7) and becomes a
  **deliberate, gated artifact**: `specs/design/_design-system.md` (`design: DESIGN-SYS`) promotes
  the first four primitives — **Button · SegmentedControl · ConfirmInline+Dialog · EditableField** —
  into one canonical kit surfaces compose. Authored per this process (GATE 1 distinctiveness →
  GATE 2 flow coverage); the **component-library *code*** stays downstream (§6 unchanged). New
  primitives still emerge per DESIGN-7 as a 2nd surface needs them.
