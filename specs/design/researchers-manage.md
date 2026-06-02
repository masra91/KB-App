---
design: DESIGN-RESEARCHERS
implements: SPEC-0028
title: Researchers / Manage view — Visual Design ("The Field Desk")
type: design
status: active   # both SPEC-0033 gates cleared 2026-06-02 → checked in as a living design spec
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0028, SPEC-0033, SPEC-0027, SPEC-0017]
design-system: pipeline-visualization.md   # reuses "The Line" tokens/type/motion (DESIGN-7 coherence)
gates:
  ai-patterns: approved      # GATE 1 — KB-AI-Detector (distinctiveness) — 2026-06-02, no rejections
  qa-flow-coverage: approved # GATE 2 — KB-Quality-Driver (all key flows) — 2026-06-02
stage: Cross-cutting
---

# Researchers / Manage view — Visual Design ("The Field Desk")

> Surface #2 in the SPEC-0033 design stream. Redesigns the Researchers Manage view (today a
> dev-ish stack of native dropdowns + text inputs) into a product surface. **Reuses the design
> language locked in SPEC-0032 "The Line"** (`pipeline-visualization.md`) so the app reads as one
> system (DESIGN-7), adapted from a live tracker to a manage/config surface. Documents structure ·
> color · theme · typography · motion · visual language + key flows; passes both gates before
> check-in.

## 1. The concept — a field desk of dispatchable agents

If "The Line" is the refinery floor (the machine, working), the Researchers view is the **field
desk**: the roster of agents you send *outside* the KB to bring back cited material — Web, a
codebase, your work tools. Each researcher is an **instrument you brief and dispatch**, not a
form to fill. The organizing ideas:

1. **Clearance = temperature.** The one thing that actually matters about a researcher is *how far
   its data can travel* (egress tier, RESEARCH-8). We map it to the same heat scale as The Line:
   **local-only = patina** (cool, stays home), **internal-tenant = brass** (your org), **public-web
   = ember** (warm — reaches the open world). One glance tells you a researcher's exposure. This is
   the distinctive organizing element and it replaces the ugliest part of today's UI (a bare egress
   `<select>`).
2. **Brief → dispatch → report.** A researcher reads as standing orders (the instructions box) + a
   **Run** that *dispatches* and comes back with a **report** — "brought back 2 cited sources" /
   "nothing new this pass" / "couldn't run". Not a button that prints a gray string.
3. **Armed vs at-rest.** Enabled = the agent is live and will reach out; its identity rail lights in
   its clearance color. Disabled = cool graphite. The dangerous state (reaching outside your KB) is
   never ambiguous.

### What this is deliberately NOT (anti-generic-AI — GATE 1 / DESIGN-3)

| Generic AI-app tell | What we do instead |
| --- | --- |
| Indigo/violet, purple gradient | The Line's palette — graphite + clearance-temperature (patina/brass/ember) + oxide for failure |
| Inter / geometric sans everywhere | Saira Condensed UPPERCASE for kind/labels, IBM Plex Mono for counts/timestamps, IBM Plex Sans body (bundled — §4) |
| Rounded "setting cards" with drop-shadows in a grid | Flat **instrument strips** on a ruled spine, no card chrome, no elevation |
| **Bare `<select>` dropdowns** for source + egress (today's exact pain) | Source = **named kind** w/ glyph; egress = a **clearance ladder** (3 lit rungs), not an enum picker |
| Chat bubble / "ask the assistant" framing | A field desk — briefs + dispatch + reports |
| A spinner + a gray "no new finding" string for every outcome | A typed **report line**: found (patina) / nothing (calm muted) / failed (oxide) — visually distinct |

## 2. Structure & layout

A roster of **researcher strips** on a single ruled spine (echoing The Line), each strip a briefed
instrument. The add-control is a row of **named template tiles**, not a dropdown.

```
┌ RESEARCHERS ──────────────────────────────────────────────────────────────┐
│ Agents that reach outside your KB and bring back cited sources.             │
│                                                                             │
│ ┌── web-1 ─────────────────────────────────────────────  ◉ ENABLED ──┐     │
│ │ ◇ PUBLIC WEB        clearance ▸ local ░  internal ░  ●PUBLIC▓        │     │  ← named kind + clearance ladder
│ │ STANDING ORDERS                                                      │     │
│ │ ┌─────────────────────────────────────────────────────────────────┐ │     │
│ │ │ Prior art + press releases on quantum error-correction; prefer  │ │     │  ← instructions = agent orders
│ │ │ arxiv.org and vendor blogs from the last 12 months.             │ │     │
│ │ └─────────────────────────────────────────────────────────────────┘ │     │
│ │ scope quantum-computing     schedule Daily ▾    autonomy Guarded ▾   │     │  ← config (named, compact)
│ │ ─────────────────────────────────────────────────────────────────── │     │
│ │ last dispatch 2h ago · brought back 2 cited sources        [ ▷ RUN ] │     │  ← brief→dispatch→report
│ └──────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│ ┌── code-1 ────────────────────────────────────────────  ○ PAUSED ───┐     │
│ │ ◆ LOCAL REPOSITORY  clearance ▸ ●LOCAL▓  internal ░  public ░       │     │
│ │ repo /Users/…/KB-App          PRs masra91/KB-App (read-only)        │     │  ← template-specific, labeled
│ │ … (standing orders, config, report as above) …                     │     │
│ └──────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│ DISPATCH A NEW RESEARCHER                                                   │
│   [ ◇ Public Web ]  [ ◆ Local Repository ]  [ ▣ WorkIQ/M365 ]  [ ＋ Custom ]│  ← named tiles, not a <select>
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Researcher strip** — one ruled instrument per researcher (not a floating card). Header: `id` +
  **armed indicator** (`◉ ENABLED` ember-lit in clearance color / `○ PAUSED` graphite). Identity
  row: the **named kind** (glyph + UPPERCASE label) + the **clearance ladder**. Then **standing
  orders** (instructions), a compact **config** line, and the **dispatch/report** footer.
- **Clearance ladder** — three rungs `local · internal · public`, the active one filled in its
  temperature color, the others ghosted. Changing it *narrows* freely; *widening* (toward public)
  triggers the confirm (RESEARCH-8 risky change). Replaces the egress dropdown with a legible
  exposure scale — the security posture is now spatial, not buried in an enum.
- **Named kind** — `◇ Public Web` / `◆ Local Repository` / `▣ WorkIQ/M365` / `＋ Custom`
  (RESEARCH-17 short labels), glyph-coded; the long description is helper text on first add, not
  permanent clutter.
- **Template-specific fields** — labeled inline under the kind: Code → `repo` + `PRs (read-only)`;
  M365 → `tenant`. Clearly captioned, not loose inputs.
- **Reach readout** — a compact, always-visible line under the clearance ladder showing **what this
  researcher may reach**: its current **budget** (e.g. `budget 8 calls / pass`) + **MCP / tool
  allowlist** (e.g. `tools: web.search · web.fetch`), tabular/mono. Read-only in this v1 (the
  *editor* is deferred, §10), but the **posture is always legible** — you can see a researcher's
  reach + spend ceiling without opening anything (KB-QD GATE-2 ask; RESEARCH-15).
- **Add = named tiles** — the four templates as selectable tiles (glyph + label), each creating a
  **disarmed** researcher (safe; enabling later is the gated step). No `<select>`.

**Responsive:** strips stack; the config line wraps below the standing-orders box; the clearance
ladder stays inline (it's small). Nothing hidden.

## 3. Color & theme (reused from "The Line", `pipeline-visualization.md` §3)

Same tokens; one surface-specific mapping — **egress tier = clearance temperature**:

| Egress tier (RESEARCH-8) | Token | Reads as |
| --- | --- | --- |
| `local-only` | `--viz-patina` `#5FA38C` | stays on this machine — coolest, safest |
| `internal-tenant` | `--viz-brass` `#C7A24A` | your org / tenant |
| `public-web` | `--viz-ember` `#E8743B` | reaches the open internet — warmest |

- **Armed researcher** → its identity rail + armed dot light in its clearance color; **disabled** →
  `--viz-idle` graphite. Enabling a public-web researcher visibly *warms* the strip — the act of
  "now reaching outside" is felt, not just checkbox-toggled.
- **Run report states** carry distinct color (the failed≠empty fix — see §5/§6): found = `--viz-patina`,
  nothing-new = `--viz-ink-muted` (calm), **failed = `--viz-oxide`** (needs attention).
- **Contrast rule inherited** (`pipeline-visualization.md` §3): state hues only on fills / glyphs /
  borders / large display; small body + the instructions text stay `--viz-ink` (14:1). Oxide never
  on small text — a failed-run *reason* renders in ink, oxide carries the marker + strip border.

## 4. Typography (reused from "The Line" §4)

Same bundled, self-hosted faces — **Saira Condensed** (UPPERCASE kind/labels/section heads),
**IBM Plex Mono** (tabular: citation counts, last-run timestamps, budget), **IBM Plex Sans** (body
+ the standing-orders textarea). The hard rule carries over: **bundle them; never fall back to
system-ui/Inter.** The instructions textarea uses Plex Sans at a comfortable reading size — it's the
one place the Principal writes prose, so it reads like a writing surface, not a config field.

## 5. Motion (reused vocabulary, minimal for a config surface)

A manage surface is mostly at rest, so motion is sparser than The Line — two of the three verbs:
- **Arm/disarm** — toggling enabled transitions the strip rail from graphite to its clearance color
  (`240ms` ease). The state change *is* the motion; no idle animation on a resting roster.
- **Dispatch (ember breathe)** — while a Run is in flight, the **Run control** breathes ember
  (`opacity 0.6↔1.0 / 1.8s`) and reads `DISPATCHING…`; it settles to the report on return.
- **Odometer** — the citation count in a report ticks to its value (tabular figures).
- **Calm idle / reduced-motion / performance** — inherited from The Line §5: at rest nothing moves;
  `prefers-reduced-motion` makes every transition instant (arm = snap, dispatch = static label,
  count = snap) with full functional parity; transform/opacity only.

## 6. Component anatomy

- **Researcher strip** — ruled container, no card chrome (inherits §6 guardrails of The Line: no
  radius on structure, no shadow, ember focus rings, no UI-kit Card surfaces).
- **Armed indicator** — `◉ ENABLED` (clearance-color) / `○ PAUSED` (graphite). The single most
  important state on the strip.
- **Clearance ladder** — 3 rungs, active filled in temperature color; widening confirms.
- **Standing-orders box** — captioned `STANDING ORDERS`, a generous Plex Sans textarea, template-
  aware placeholder ("Prior art on…" / "Answer questions about this repo…" / "Updates in my mail…").
  Saved on an explicit **Save** (steering, not risky — no confirm); a blank save keeps the prior
  value (backend guard, already shipped).
- **Config line** — `scope` (text), `schedule` + `autonomy` as **compact labeled selectors** (named
  values: Off/Hourly/Daily…, Guarded/Autonomous — not bare enums). Autonomy→Autonomous confirms.
- **Dispatch/report footer** — `last dispatch <ago> · <report>` + the **Run** control. The report is
  typed and color-coded:
  - **found** → "brought back N cited sources" (patina, N tabular). Links to the cited sources.
  - **nothing** → "nothing new this pass" (calm muted — a *valid* outcome, never styled as error).
  - **failed** → "couldn't run — <reason>" (**oxide**, needs attention). Visually distinct from
    nothing — this is the design half of the #160 fix (failed must not masquerade as empty).
  - **escalation** (RESEARCH-11 depth cap → Review) → "paused — needs your OK to continue" (brass,
    actionable), linking to Reviews.
- **Add tiles** — four named template tiles; selecting one + an id creates a disarmed researcher.
- **Confirm affordance** — risky changes (enable / →autonomous / widen clearance) reveal an inline
  confirm worded as the consequence ("It will reach Public web on its Daily schedule"), not a generic
  "Are you sure". Single-flight.

### Implementation guardrails — config surfaces drift hardest (GATE-1 watch-items)

A config screen is exactly where a dev reaches for a UI-kit's form components and silently
re-introduces the generic look. On top of The Line's inherited guardrails (flat ink, no
radius/shadow on structure, ember focus rings, no UI-kit Card/Paper surfaces), this surface adds:
- **The clearance ladder is a real spatial component, NOT a restyled `<select>`/dropdown.** The
  whole distinctiveness rests on it being a 3-rung exposure scale read at a glance; collapsing it to
  a styled native picker defeats the design.
- **`schedule` / `autonomy` selectors and the add-tiles are custom instrument components, not bare
  native `<select>` or a UI-kit `Select`.** The anti-tell table rejects dropdowns for source+egress;
  carry that intent down to these lower-stakes controls so native chrome doesn't leak back in.
- **No UI-kit `Card` / `Paper` / `Switch` / rounded / shadow on the strips.** Form-heavy surfaces are
  where component libraries pull hardest; the armed toggle and strips are flat-ink instrument parts,
  not a Switch in a Card.

## 7. Key user flows covered (GATE 2 — KB-Quality-Driver)

| # | Flow (SPEC-0028 §6 / RESEARCH-15/17) | How the design serves it |
| --- | --- | --- |
| 1 | **Add a researcher** — pick a template → configure → enable | Named **template tiles** → a new **disarmed** strip appears → brief it → arm (confirm) |
| 2 | **Configure** prompt / scope / egress / schedule / autonomy (+ template fields) | Standing-orders box + config line + **clearance ladder** + labeled template fields (repo/PRs/tenant) |
| 3 | **Enable / disable** (risky — starts egress) | Armed indicator + clearance-color rail; enable/→autonomous/widen-clearance reveal the consequence-worded confirm |
| 4 | **Run now → result** | **Run** dispatches (ember breathe) → typed **report**: found / nothing / **failed (oxide, distinct)** / escalation |
| 5 | **See last-run + findings/citations + escalations** | Report footer: `last dispatch <ago>` + cited-source count (links out) + escalation state (RESEARCH-15) |

Plus the distinct identity (DESIGN-3) and design-system coherence with The Line (DESIGN-7).

## 8. Requirements traceability

| Req | Where served |
| --- | --- |
| RESEARCH-15 manage view: add / configure / enable / run-now / last-run + escalations | §2 strip + add tiles, §6, §7 |
| RESEARCH-17 instructions box + scope + short template labels + egress as named choice | §6 standing-orders, §2 named kind + clearance ladder |
| RESEARCH-8 egress gated per tier (legible exposure) | §3 clearance-temperature + §2 ladder |
| RESEARCH-11 escalation on depth cap → Review | §6 report "paused — needs your OK" |
| DESIGN-2 authored: structure/color/type/motion/language | §§2–6 |
| DESIGN-3 distinct, not generic-AI | §1 concept + anti-tell table |
| DESIGN-5 checked in as a living design spec | this file |
| DESIGN-7 coherent design system across surfaces | reuses The Line tokens/type/motion (§§3–6) |

## 9. Data dependencies / notes for the implementer

Binds to the shipped `ResearcherView` (`researchersPanel.ts`) — id, template, label, prompt, scope,
egressTier, enabled, schedule, posture, topics, `lastRun {ts, eventType, what, citations, sourceId}`,
+ template config (repoPath, prRepo, tenantId). Two notes:

1. **Failed≠empty report (§6).** `runResearcherNow` already returns `{reason}` on failure vs
   `{sourceIds}` on success (empty array = nothing-new), so the three report states are
   distinguishable in today's data. The design *requires* they render distinctly (oxide vs calm).
   **This is the UI half of #160** — the backend half (stop swallowing the packaged-app cliPath
   failure as `found:false`) must land so a real failure actually arrives as `{reason}`, not a
   silent empty. Flagging the dependency, not duplicating the fix.
2. **Escalation state (RESEARCH-11/15).** Surfacing "paused — needs your OK to continue" needs the
   last-run/researcher state to carry an escalation flag (a depth-cap → Review event). Confirm the
   `lastRun.eventType` / a researcher status exposes this; if not, it's a small view-model addition
   (like SPEC-0032's §9 deps). Confirm with DEV-3/DEV-5 (RESEARCH owners) at impl time.

## 10. Out of scope

- The researcher **runtime / dispatch / egress enforcement** — SPEC-0028 backend; this is the
  manage surface only.
- **Budget/MCP-allowlist *editors*** — RESEARCH-15 lists budget/MCP config; v1 of this redesign
  focuses on the painful surfaces (kind, clearance, instructions, run→report). The **readout** of
  current budget + MCP allowlist **IS in v1** (§2/§6 reach readout — reach is always *visible*); only
  the *editing* UI is the follow-on within the same language. **Tracked against RESEARCH-15** so
  "manage view" isn't later read as fully complete (KB-QD GATE-2 note).
- The **#160 backend fix** (cliPath + stop-swallowing) — a dev mission; this spec only requires the
  failed-state be visually distinct.

## 11. Decisions (rationale → `decisions`)

- **Egress tier = clearance temperature** (patina/brass/ember) — turns the worst dropdown into the
  surface's most legible, distinctive element, and reuses The Line's heat metaphor.
- **Source kind as named tiles + glyph, not a `<select>`** — directly answers the Principal's steer
  (Public Web · WorkIQ/M365 · Local Repository · Custom as clear choices).
- **Reuse The Line's tokens/type/motion rather than invent a second language** — DESIGN-7 coherence;
  a shared `specs/design/_design-system.md` should be factored out once a 3rd surface lands (noting
  it now so the duplication is intentional, not drift).
- **Typed, color-coded report (found/nothing/failed/escalation)** — makes "Run now" read like a
  product and makes failure legible (supports #160).

## 12. Changelog

- 2026-06-02 — created (draft). Visual design for the SPEC-0028 Researchers / Manage view:
  **"The Field Desk"** — researcher strips on a ruled spine, **egress tier = clearance temperature**
  (patina/brass/ember) replacing the egress dropdown, source **kind as named glyph-tiles**, a
  framed **standing-orders** instructions box, and a typed **brief→dispatch→report** loop
  (found/nothing/**failed-oxide**/escalation) that makes failure distinct from empty (UI half of
  #160). Reuses "The Line" tokens/type/motion (DESIGN-7). Flags 2 impl notes (the #160 backend half;
  escalation-state exposure). Pending GATE 1 (KB-AI-Detector) + GATE 2 (KB-QD).
- 2026-06-02 — **GATE 1 (KB-AI-Detector) APPROVED**, no rejections. Folded in the 3 config-surface
  implementation watch-items as explicit §6 guardrails: the clearance ladder must be a real spatial
  component (not a restyled `<select>`); schedule/autonomy/add-tiles must be custom instrument
  components (not native/UI-kit selects); no UI-kit Card/Paper/Switch/rounded/shadow on strips.
  Awaiting GATE 2 (KB-QD, flow coverage).
- 2026-06-02 — **GATE 2 (KB-Quality-Driver, flow-coverage) PASS** — all 5 flows covered; the
  disarmed-default + consequence-worded confirm + failed-distinct trio rated a genuinely safe
  egress-control surface. Folded in KB-QD's one note: added an always-visible **reach readout**
  (current budget + MCP allowlist) to the strip (§2/§6) so a researcher's reach is legible even
  before the editor lands; clarified §10 that the readout ships in v1 (only the editor defers),
  tracked against RESEARCH-15. **Both gates GREEN → status `active`, checked in.**
