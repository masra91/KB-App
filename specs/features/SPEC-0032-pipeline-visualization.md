---
spec: SPEC-0032
key: VIZ
title: Pipeline Visualization & Live Tracker (the machine, alive)
type: feature
status: draft
owners: [KB-Lead, Visual-Design-Lead, Principal]
created: 2026-06-02
updated: 2026-06-13
related: [SPEC-0003, SPEC-0014, SPEC-0017, SPEC-0020, SPEC-0030]
stage: Cross-cutting
supersedes: null
---

# Pipeline Visualization & Live Tracker (the machine, alive)

> Make the autonomous pipeline **legible and alive**. Today the Status view is static text that
> jumps from "0 idle" to sudden numbers — it doesn't *feel* like a working machine. Turn it into
> a **real-time, lightly-animated** experience where the Principal can **watch a source move
> through the stages** (a "pizza tracker" for knowledge), see the **funnel/throughput**, and
> trust the machine is working. A deliberate, **significant visual investment** — and the first
> surface where the app earns a **distinct visual identity** (not another generic AI app).

## 1. Intent (the why / JTBD)

A second brain that works silently in the background needs a window that makes that work
**believable and understandable**. The current Status view (SPEC-0030) answers "is it stuck?"
but it reads as a spreadsheet: counts appear out of nowhere (stale polling), nothing moves, and
you can't follow a single item's journey. JTBD: *"let me watch my KB think — see a thing I just
captured move step-by-step through the pipeline, see the whole flow's health at a glance, and
feel that it's alive — in a UI that looks like *this* app, not every AI app."*

This is **presentation over the OBS data** (SPEC-0030's status + spans/perf index). OBS is the
substrate; VIZ is the experience.

## 2. Principles

- **Alive, not static** — real-time + event-driven + lightly animated. Work *flows*; **idle is
  calm**, not jarring.
- **Two lenses** — **per-item** (a source's journey) and **per-stage** (funnel/throughput),
  pivotable on the same data.
- **Legible at a glance** — where is everything, what's stuck, where's the time going.
- **Distinct** — a visual language recognizably *this app* (the Visual-Design-Lead owns it),
  not the default chat-card-purple-gradient AI look.

## 3. The views

- **Per-item tracker ("pizza tracker")** — each in-flight source as a horizontal **stepper**
  across stages (Capture → Archive → Decompose → Connect → Claims → Promote): completed steps
  filled, the **current step lit + animated**, errored/set-aside steps flagged (with **Retry /
  Dismiss**, OBS-17). Capture something and *watch it advance*.
- **Funnel / aggregate** — counts + **conversion** at each stage (captured → candidates →
  **deduped** entities → claims → promoted), so throughput and the dedup ratio are visible.
- **Per-stage bars** — each stage's queue / active / throughput, **segmented by source**; slow
  stages surface their **Copilot latency** (OBS-14, the where-time-goes).
- **Pivot** — toggle **per-item ↔ per-stage**.

## 4. Real-time & motion

- **Event-driven** — main **pushes** stage transitions to the renderer (IPC event channel), so
  state is live, not a slow poll. (Fixes the "0 → sudden numbers" jank.)
- **Smooth** — counts **interpolate/animate** rather than snapping; active stages **pulse**;
  items **flow** between stages.
- **Calm idle** — when nothing's happening, the view is quiet, not flashing.
- **Performant** — updates **coalesced/debounced**; smooth even with many in-flight items.

## 5. Visual identity (Visual-Design-Lead owns)

This is the **first canvas** for the app's visual language — motion, color, typography, layout
that make it recognizably itself. Explicit goal: **not look like a generic AI app.** The
Visual-Design-Lead defines the language (and an **"AI-patterns detector"** to flag when a screen
drifts into the default AI look); this spec sets the intent and the surface.

## 6. Requirements

| ID    | Priority | Statement (short)                                                                    | Verify   | Traces |
| ----- | -------- | ------------------------------------------------------------------------------------ | -------- | ------ |
| VIZ-1 | should   | The status surface is **real-time + event-driven** — stage transitions **push** to the UI and counts **animate/interpolate** rather than jumping (fixes the "0 → sudden numbers" jank) | test:app/src/shell/views/lineMotion.test.ts (counts animate/interpolate — odometer roll); **event-driven push deferred** (still the SHELL-12 poll) | OBS-8 |
| VIZ-2 | should   | A **per-item tracker** ("pizza tracker") shows each in-flight source as a **stepper** across stages, current step lit + animated, completed filled, errors/set-aside flagged | none-yet | OBS-5; ORCH-12 |
| VIZ-3 | should   | A **funnel/aggregate** view shows counts + **conversion** per stage (captured → candidates → deduped entities → claims → promoted) — throughput + dedup visible | none-yet | OBS-14; CONNECT-3 |
| VIZ-4 | should   | **Per-stage bars** show queue/active/throughput **segmented by source**, surfacing slow stages' **Copilot latency** | none-yet | OBS-5,14 |
| VIZ-5 | should   | The view **pivots** between **per-item** and **per-stage** lenses on the same data | none-yet | OBS-5 |
| VIZ-6 | should   | **Light, purposeful animation** signals work (active pulse, items flowing); **idle is calm** | test:app/src/shell/views/lineMotion.test.ts (signature index + reduced-motion parity); ember-breathe + idle-cool = CSS (Design-Lead visual gate) | VISION-13 |
| VIZ-7 | should   | Set-aside/errored items are **visually prominent** and carry the **Retry/Dismiss** actions (OBS-17) | none-yet | OBS-17 |
| VIZ-8 | should   | The visualization establishes a **distinct visual identity** (motion/color/layout language) so the app is recognizably itself — **not the generic AI-app look**; authored + gated per the design process (SPEC-0033) | none-yet | VISION-13; DESIGN-3 |
| VIZ-9 | should   | The live view is **smooth/performant** (coalesced/debounced updates, no reflow storms) even with many in-flight items | none-yet | PRIN-5 |
| VIZ-10 | should  | **Funnel numbers are legible — each declares its role; backlog ≠ projection.** A station stacks **four number-roles** — **volume** (reached-here), **conversion projection** (to-next, the VIZ-3 `+N (×r)`/`−N deduped` caption), **queue** (waiting-here), **latency**. Each MUST **declare its role at a glance**: volume carries its **bucket noun** (`399 entities`); the conversion caption is tied to the **next** stage with a `→ … fan-out`/`deduped` signifier so a **projection can never read as a backlog**; the real **queue** — the *only* actionable backlog — sits in a **distinct typographic lane**, taking **brass (needs-you) only when the queue is *stuck*, NOT merely deep**: a draining queue is healthy work (a big import legitimately runs hundreds deep), so brass is gated on the stage being **`blocked`/`error`** or the pipeline **`stalled`** (OBS-11) with a non-empty queue — *never a raw depth threshold* (which would cry wolf under normal heavy load). A once-per-spine **legend** decodes the caption grammar, and `title=` **decode-on-hover** puts the exact meaning a hover/focus away. *(Principal misread the Linking `+1116 (×3.8)` projection as queue depth — projection and backlog blurred.)* | none-yet | VIZ-3; OBS-5,11; DESIGN-3 |
| VIZ-12 | should  | **The Status bars show PENDING WORK, not the cumulative end-state.** The Principal's mental model: *"what I want visually in the bars is pending items — a bar that shows all pending, with a slight fade / color difference for the in-progress ones."* Today the view reads as a **final total** (everything that's ever flowed through), which "doesn't really make sense" as a live picture and looks stuck/stale. Re-orient the primary status visualization to **work-in-motion**: per stage, show **queued (waiting) vs in-progress (active)** — the **in-progress items visually distinct** (faded / different color / pulse) from the merely-queued — so a glance answers *"what's being worked right now and what's waiting."* Cumulative totals/throughput remain available but **secondary** (a separate funnel/lens, VIZ-3), not the headline. Must be **live + never stale-stuck** — reads the maintained snapshot + updates by push (SHELL-12 / OBS-24); a frozen "pending" bar is the bug, not the feature. Net-new visual → KB-Design-Lead authors (→ KB-Lead HYBRID). *(Principal: "I still don't like the status view… it shows the final total state but that's not what I want… show pending, fade the in-progress… or maybe it does but then it's just stuck again / out of date.")* | test (**data**): `app/src/kb/pipelineStatusView.test.ts` → `pendingForStage` (per-stage queued-vs-in-progress from the roster, incl. archive's prepended processing item). **Visual** (bars rendering queued vs faded-in-progress) → KB-Design-Lead authors, KB-Lead HYBRID | SHELL-12; OBS-24; VIZ-1,2,3; DESIGN-3 |
| VIZ-11 | should  | **Make the fan-out VISUAL — show the work *multiplying* down the chain.** Beyond the per-station `×ratio` caption (VIZ-10), the surface makes the funnel's **multiplication intuitive**: a representative **flow** of *one source → N candidates → M entities → P claims → links* — *"one source becomes ~4 claims becomes ~Y links"* — so the fan-out reads as a **widening stream / branching chain**, not a bare number + a cryptic `×`. Complements the VIZ-3 funnel + VIZ-10 role-legibility. The visual is **net-new** → KB-Design-Lead authors it (→ KB-Lead HYBRID classify). *(Principal: "I love that fan-out explanation — we should make it clear and maybe even visual: one source is making X claims is making Y links…")* | none-yet | VIZ-3,10; DESIGN-3 |

## 7. User flows / surface

- Open **Status** → see the **funnel** (10 captured → 7 entities → 22 claims → promoted) and,
  below, the **per-item trackers** for anything in flight.
- **Capture a note** → its tracker appears and **advances step-by-step** (Archive ✓ → Decompose
  ⟳ → …), the active stage pulsing.
- A source **set aside** → its tracker shows the error step in red with **Retry / Dismiss**.
- **Pivot to per-stage** → see Connect at 22 items/min, p95 Copilot latency 14s.

## 8. Out of scope (for now)

- The **knowledge graph** visualization — that's Obsidian / VAULT (SPEC-0031); VIZ is the
  **pipeline** tracker.
- **Historical replays** of past pipeline runs — Activity (SPEC-0029) covers history; VIZ is now.
- The **full design system / component library** — the Visual-Design-Lead's broader effort;
  VIZ is the first surface, not the system.

## 9. Open questions

- [ ] **Primary lens** — per-item or per-stage as the default landing view?
- [ ] **Scale** — how many in-flight item-trackers before we aggregate/virtualize?
- [ ] **Motion budget** — how much animation before it distracts (accessibility: reduced-motion).
- [ ] **Push mechanism** — a dedicated IPC event channel vs. a fast poll of the OBS status/perf index.
- [ ] **Visual language** — color/motion/type/identity, and the **AI-patterns detector** —
      Visual-Design-Lead to define (this spec sets intent, not the pixels).

## 10. Changelog

- 2026-06-13 — **The Line motion — slice 1 (KB-Developer-4 → PR #338, visual gate KB-Design-Lead, code
  gate-2 KB-QD-2).** The §5 motion layer the spec called for but was never built. `lineMotion.ts` applies
  two JS-driven motions after each (change-guarded, full-innerHTML) repaint, carrying the prior value in
  a keyed store so a roll/index survives the node-destroying repaint: **odometer** (VIZ-1) — the funnel
  volume counts + in-flight total roll from their last value to the new one (400ms ease-out, the
  `--viz-dur-odometer` window), fixing the Principal's "0 → sudden numbers" jank; **signature index**
  (§5) — a carriage whose stepper advanced a station since the last render gets the 220ms translateX
  settle (`--viz-dur-index`/`--viz-ease-index`). Pure + injected (clock/rAF/reduced-motion) → unit-tested
  with a synchronous fake rAF; reduced-motion snaps (full parity — state also reads via fill+hue; ENG-15/16:
  malformed/keyless elements skipped, never throw, one bad never aborts the rest). transform/opacity only
  (VIZ-9). **Honest scope:** this is the *animate-not-jump* half of VIZ-1 — the **event-driven push**
  channel (§10) is still the SHELL-12 poll, deferred to a later slice; the **conversion-caption delta
  roll** + **VIZ-2 click-to-expand per-hop trace** are fast-follows. Coordinated file-split with
  KB-Developer-6 (DEV-6 = VIZ-12 pending bars; me = carriages/funnel/pivot/motion).
- 2026-06-13 — **VIZ-12 data implemented** (KB-Developer-2). The pending-work derivation that re-orients
  the Status bars from cumulative totals to **work-in-motion**: `pendingForStage(inFlight, stage)` (pure,
  `pipelineStatusView.ts`) splits a stage into `inProgress` (the active draining batch) vs `queued`
  (waiting), derived from the in-flight roster's per-item `active` flag (the source of truth — exact, and
  it counts archive's separately-prepended `processing` item correctly rather than guessing from
  queueDepth). The **visual** (the bars rendering queued vs faded/distinct in-progress, reading the
  maintained snapshot so it's live + never stale-stuck) is **net-new → KB-Design-Lead authors, KB-Lead
  HYBRID** — it consumes this data off `view.inFlight`. `Verify` graduated for the data half.
- 2026-06-08 — **VIZ-10: funnel-caption legibility (Principal-reported).** The Principal read the Linking
  gauge-rail's `399` + `+1116 (×3.8)` as a **queue depth/backlog** — it's actually *volume* (399 entities
  reached Connect) + a *fan-out projection* into Claims, not live work waiting. The station stacks four
  number-roles (volume · conversion projection · queue · latency) and two were bare adjacent numerics that
  blurred. VIZ-10 requires each number to **declare its role** (volume + bucket noun; projection tied to the
  next stage with `→`/`fan-out`/`deduped` so it can't read as backlog; the real queue in its own lane, brass
  when concerning; latency labeled) + a once-per-spine **legend** + `title=` decode-on-hover. The design is
  authored in `specs/design/pipeline-visualization.md` §6 (PR #270, KB-Lead HYBRID-classify PASS — blessed
  primitives, no new tokens). Pairs with the broader Status clarity/usability pass.
- 2026-06-02 — created (draft). The **rich, real-time, distinct** visual layer over the OBS
  pipeline data (SPEC-0030): a **per-item "pizza tracker"**, a **funnel/conversion** view, and
  **per-stage** bars, **pivotable**; **event-driven + animated** (fixing the "0 → sudden numbers"
  jank), with **Retry/Dismiss** on set-aside items (OBS-17). Establishes the app's first
  **distinct visual identity** surface (not the generic AI look) — Visual-Design-Lead-owned, with
  an "AI-patterns detector" to keep it distinct. A deliberate, significant visual investment;
  the **Principal is adding a Visual-Design-Lead** and starting a visual-polish push.
