---
spec: SPEC-0060
key: VUX
title: Vellum v3 UI — whole-app visual & IA direction
type: feature
status: active
owners: [KB-Lead, KB-Design-Lead, KB-Design-Lead-2, Principal]
created: 2026-06-28
updated: 2026-06-28
related: [SPEC-0050, SPEC-0053, SPEC-0057, SPEC-0058, SPEC-0026, SPEC-0029, SPEC-0018, SPEC-0013, SPEC-0020]
supersedes: null
---

# Vellum v3 UI — whole-app visual & IA direction

> One language for every view: rebuild the whole app in the warm-vellum "Today"
> language from the data up, retire the old instrument-panel (`--viz-*`) system, fix
> the layout clamp, add a real top bar, and apply two motion signatures — so the app
> stops feeling half-finished.

**Visual reference (the source of truth for *look*):** `design-prototypes/vellum-v3.html`
— a clickable mock of the entire app (every view, real data shapes). This spec is the
*what/why*; the prototype is the *what it looks like*. When they disagree, the Principal
arbitrates; otherwise the prototype wins on visuals and this spec wins on behavior.

## 1. Intent (the why)

The packaged build (06-28 walkthrough) read as "almost the same / low-polish / hangs"
despite the Vellum reskin. Root cause was **two visual systems running at once**: the
warm-vellum card language (Today, Explore — which the Principal loves) and the old
`--viz-*` instrument-panel language (Status/Health/Agents/Sources — boxes, gauges,
half-circles). Half the app never left the old language, so the reskin read as shallow.
A single CSS rule (`index.css` `.content .view{max-width:34rem}`) additionally suffocated
every view into a narrow column regardless of window size.

v3 is **not a reskin**: it is a page-by-page, ground-up rebuild of every view in the
Today language, killing the `--viz-*` system, removing the width clamp, adding the top
bar and motion the brand always implied. The bar for "done" is: *if we built this view
now, at the polish Vellum wants, what would it be?*

## 2. Scope

**In scope:**
- A single cross-cutting visual language + token system (carried from `vellum-ux-v2.html`).
- A real **top bar**, a **reordered rail**, and IA moves: Status dissolved, Sources→Connectors,
  watched-folders→Settings.
- Two **motion signatures** (loom = continuous work, churn = episodic thinking).
- A from-scratch direction for every main view (Today, Ask, Capture, Reviews, Activity,
  Explore, Health, Agents, Connectors, Settings) + the **Guidance** surface (UI for SPEC-0050)
  and a first-class **"you"** identity.

**Out of scope (for now):**
- **Dark / night-study** variant — a parallel pass off the new language, not this cut.
- The deeper **linking / claims / confidence model** rethink behind Explore edges — its own
  zoom-out design session (tracked as an open question), not a v3 polish item.
- Re-architecting data contracts. v3 renders the **existing** per-view data; where a view
  needs new data (e.g. per-claim confidence) that stays HELD to its own spec.

## 3. The language (cross-cutting)

- **Surfaces.** Warm `--linen` cards on a `--vellum` ground; cool blue-tinted card shadow +
  warm inner top-light; hairline `--hair` borders; vellum grain over the window. No black
  borders, no heavy boxes, no clipping/overlap.
- **Type.** Spectral (voice: names, headings, prose, quotes), Inter (UI/body), IBM Plex Mono
  (numbers, timestamps, ids).
- **Color discipline (hard — per brand SPEC-0057/reskin).** ember = *needs your decision* ONLY ·
  sprout = active/in-progress · gold/brass = rationed accent + the "always-working" thread ·
  oxide = error/failed (never on small text) · viridian = settled / primary CTA · slate =
  interactive (links, focus). No generic blue/indigo anywhere.
- **Copy.** Calm, sparse, confident, human. No instructive AI-slop microcopy. No creator-only
  jargon in the UI (reads/pass, orient/pass, depth, "tools template default" are bugs, not
  labels — replace or tuck under "Advanced"). Humanize timestamps ("6m ago", "last night");
  never raw ISO/Zulu.
- **No AI-tell "bumper" cards.** Attention surfaces (Reviews, "Needs you") use a warm gradient
  + an ember glyph, NOT a colored leading-edge left border.

## 4. Information architecture

- **Top bar** (new): themed (warm, not aqua) with global ⌘K **search**, **Quick add**, and a
  per-view **contextual filter slot**.
- **Rail order:** Today · Ask · Capture · Reviews · Explore · Activity · Health — *Manage:*
  Agents · Connectors · Settings. (Plus the new **Guidance** + a **"you"** identity card.)
- **Status DISSOLVED:** no standalone Status/"the Line" view. "What's moving" becomes a slim,
  legible flow-strip on **Today** (named stages, live counts, a done/working/waiting legend);
  deep pipeline diagnostics fold into **Health**; stuck/set-aside items route to **Reviews**.
- **Sources → "Connectors":** feeds (RSS, M365 mail) become a simple guided connect-a-source
  surface; **watched folders move into Settings** (vault config).
- **Settings is global-app only.** Per-question concerns (recall time/depth) live on **Ask**
  with the Quick/Considered control — not in Settings. Per-agent concerns live in agent detail.

## 5. Motion (two signatures)

- **Loom** (`.vmark.loom` / brand diamond `.is-working`) — *continuous* work: an endless outward
  pulse / inner frame emitted from center. Use for a running stage, ongoing background work.
- **Churn** (`.vmark.churn` / `.is-thinking`) — *episodic* thinking/preparing: a gyroscopic flip.
  Use for fetching an answer, building a view's state on load, page warm-up. The brand diamond
  churns briefly on every view change.
- **Never a blank async gap.** Any load shows a calm **skeleton** (Reviews, Ask), never empty.

## 6. Per-view direction

Each view is built **one-per-PR**, paired with a Design-Lead, gated on a live packaged
walkthrough. Direction below; data shapes are the existing per-view contracts.

- **Today** — the north star. Greeting + slim legible flow-strip + stat tiles + recent activity
  (descriptive: "Connected [[A]] to [[B]]") + ember "Needs you" + Health glance.
- **Ask** — a single **continued conversation** (not stacked answers); **Quick vs Considered**
  effort toggle on the ask bar; **Past chats** history; thread actions **Save chat** (app layer,
  reopenable) vs **Save to KB** (a small menu: raw transcript · summarized note · synthesized
  entity); churn thinking-state + skeleton; grounded inline citations.
- **Capture** — quiet, confident, minimal. No instructive subtitle. Generous writing surface,
  drag-drop staged-file manifest, one faint "→ your vault" cue.
- **Reviews** — warming **skeleton** (no 2s blank). Decision cards as the ember attention surface.
  Options are **set by the agent that raised the ask** (not a fixed confirm/reject); support
  **more than two candidates** when needed. Expandable context, optional note, optimistic resolve.
- **Activity** — feed of runs; search matches the **visible summary** ("obsidian" works);
  **debounced**, no flicker; **descriptive** summaries; the doer is a **stage or agent** (filter
  reads "All activity", not "All sources"). Trace/lineage panel; drill-down to raw events.
- **Explore** — entity-graph navigator that **uses the width** (full-bleed, not a column);
  optional **entity-only full map** (Obsidian-like). Edge + entity-type encoding needs a **legend**;
  entity types are many and an entity can be **multiple types** (color = primary type + a
  multi-type marker). The link/claim/confidence semantics are an open question (§8).
- **Health** — **remediation-first**: every issue and group offers an action (relink / find-homes /
  enrich / merge) on a guarded→working→review model; **plain "why it matters"**; honest framing of
  unresolved links ("Vellum couldn't resolve — may resolve in Obsidian, verify"); **dismiss/ignore
  on every issue type**; thin pages also offer **"Add context"** → a **pre-filled Capture**
  (`Regarding [[Entity]]`). Destructive actions (archive/merge) **confirm / preview** before acting.
- **Agents** — **low-config, high-info**. Librarians (pausable), Schedules (friendly, no awkward
  exact clock times), Researchers (de-jargoned front, raw limits under "Advanced"). State reads
  **On·idle vs Running** distinctly. **Every agent drills into a detail** (identity + humanized
  past-runs timeline) with a visible drill cue.
- **Connectors** — guided connect-a-source (RSS, M365 mail) as warm cards; status + humanized
  last-pull + simple schedule; guided add flow.
- **Settings** — quiet grouped preferences, global-app only; watched folders re-homed here;
  technical caps tucked under "Advanced".
- **Guidance** — the UI home for **directives** (SPEC-0050): see §7.
- **"You" identity** — see §7.

## 7. New surfaces

### Guidance (UI for SPEC-0050 Directives)
The standing interpretations the Principal gives Vellum ("when I say X I mean…", "nickname =
person", "many Bobs — be certain, don't guess") get a **home in Manage**. It is created two ways
beyond manual entry: **proposed inline during Reviews** ("save this as a standing rule") and **from
an entity in Explore**. This realizes SPEC-0050 §4's "Rules surface" — see that spec for the
directive model, durability, and the "correct this" affordance.

### "You" identity (narrator grounding)
First-person narration currently becomes a phantom "narrator" entity. The rail's user card
becomes a **first-class "you"** identity node so "I/me/the narrator" ground to the Principal, and
recall can reason over the Principal's own statements. Seeds a natural Guidance alias
("the narrator = me"). Data/model work is a follow-up to its own spec; v3 establishes the surface.

## 8. Requirements

| ID | Priority | Statement (short) | Verify |
| ---- | ---- | ---- | ---- |
| VUX-1 | must | One visual language app-wide; the `--viz-*` instrument-panel system is retired | none-yet |
| VUX-2 | must | No global width clamp; spatial views adapt to width, reading views keep a comfortable column | none-yet |
| VUX-3 | must | A top bar with global search, quick-add, and a per-view contextual filter slot | none-yet |
| VUX-4 | must | Rail order + IA: Status dissolved, Sources→Connectors, watched-folders→Settings | none-yet |
| VUX-5 | must | Color discipline held (ember = decision only; no generic blue) | none-yet |
| VUX-6 | must | Two motion signatures (loom/churn); no blank async — skeletons while loading | none-yet |
| VUX-7 | must | Copy discipline: no instructive slop, no creator jargon in UI, humanized timestamps | none-yet |
| VUX-8 | should | No colored leading-edge "bumper" cards; attention via gradient + glyph | none-yet |
| VUX-10 | must | Today: greeting + legible flow-strip (named stages, counts, done/working/waiting legend) | none-yet |
| VUX-11 | must | Ask: continued conversation, Quick/Considered, Past chats, Save chat vs Save-to-KB menu | none-yet |
| VUX-12 | must | Capture: minimal, no instructive subtitle, staged-file manifest | none-yet |
| VUX-13 | must | Reviews: warming skeleton; agent-set options (not fixed yes/no); supports >2 candidates | none-yet |
| VUX-14 | must | Activity: search hits visible summary; debounced; descriptive; "All activity" not "sources" | none-yet |
| VUX-15 | should | Explore: full-bleed; entity-only full map; legend; multi-type entities | none-yet |
| VUX-16 | must | Health: remediation per issue (guarded→working→review); dismiss-all; add-context→Capture; confirm destructive | none-yet |
| VUX-17 | must | Agents: low-config/high-info; On·idle vs Running distinct; every agent drills in with a cue; humanized schedules | none-yet |
| VUX-18 | should | Connectors: guided connect-a-source cards with humanized status | none-yet |
| VUX-19 | must | Settings: global-app only; watched folders here; recall settings live on Ask, not here | none-yet |
| VUX-20 | should | Guidance surface in Manage = UI for SPEC-0050; created from Reviews + Explore entity | none-yet |
| VUX-21 | may | "You" identity card grounds narrator/first-person to the Principal | none-yet |
| VUX-22 | must | Each view ships one-per-PR, paired with a Design-Lead, gated on a live packaged walkthrough | none-yet |

(Per-requirement detail intentionally lives in the prototype + per-view feature specs as each
view is built; this table is the addressable surface QD/Design gate against.)

## 9. Open questions

- [ ] **Explore link/claim/confidence model** — what edges *mean* (relationship vs confidence),
  how multi-type entities color, and the broader claims story. Deserves its own zoom-out session
  as the product matures and we have more user feedback. Held out of v3 polish.
- [ ] **Save-to-KB output types** — exact set (raw transcript / summarized note / synthesized
  entity) and how each writes into the vault (ties to SPEC-0013/SPEC-0020).
- [ ] **"You" identity** data model — how the Principal becomes a real node and how narration
  attributes to it (own spec).
- [ ] **Dark / night-study** variant — when and how it forks from this language.

## 10. Changelog

- 2026-06-28 — created (active). Direction locked from the `vellum-v3.html` prototype after the
  Principal's whole-app rethink (06-28 walkthrough). Hand-off to PM for per-view dispatch.
