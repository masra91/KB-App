---
spec: SPEC-0053
key: AGENTSIA
title: Manage-section Information Architecture (Agents vs Researchers vs Jobs clarity) — "WS-E"
type: feature
status: draft
owners: [KB-Lead, Design-Lead, Principal]
related: [SPEC-0027, SPEC-0028, SPEC-0023, SPEC-0006, SPEC-0033, SPEC-0048]
created: 2026-06-27
stage: Cross-cutting
supersedes: null
---

# Manage IA — make Agents / Researchers / Jobs legible

> The Principal can't tell **Agents**, **Researchers**, and **Jobs** apart in the "Manage" nav —
> they read as near-synonyms. They are in fact three distinct things; the IA just doesn't say so.
> This spec fixes the taxonomy + naming + a consistent surface, so the distinction is obvious.

## 1. What they actually are (today)
| Surface | Spec | Plain meaning |
|---|---|---|
| **Agents** | SPEC-0006 / SPEC-0027 | The system's **own pipeline workers** — archivist, decompose, connect, claims, reflect, ask. Observe + light config (model, instructions). |
| **Researchers** | SPEC-0028 | **Outward-reaching** research agents (Web / Code / M365·WorkIQ) that fetch external corroboration. Egress-gated. |
| **Jobs** | SPEC-0023 | **Scheduled autonomous tasks** (e.g. Reflect rumination) on a cadence. |
| Sources / Settings | SPEC-0027 | inputs + app config (not agent-like). |

The confusion: all three are "agent-ish background workers," shown as flat siblings with no framing
of *internal pipeline* vs *outward research* vs *schedule*.

## 2. IA shape — RESOLVED (Principal, 2026-06-27): one "Agents" hub, framed by direction
A single **Agents** hub replaces the three confusable siblings, with two clearly-headed groups whose
headers explain direction (inward vs outward):

- **Librarians — work *inside* your KB.** The system's own pipeline workers (archivist, decompose,
  connect, claims, reflect, ask). **Schedules** (recurring librarian work, e.g. Reflect rumination)
  live **here**, as *when these run* — not a separate top-level thing.
- **Researchers — reach *outside* your KB.** Web / Code / M365·WorkIQ; egress-gated.

This synthesizes the "rename for clarity" + "unify under a hub" options the Principal weighed: it
unifies the surface (one hub) **and** makes the inward/outward distinction explicit via the group
headers. "Agents" survives as the hub name; "Librarians"/"Researchers" name the two kinds; "Jobs"
becomes "Schedules" nested under Librarians. Sources + Settings stay as their own Manage entries.

**Built-in vs user-added** (ties to the delete rule, SPEC-0027 PANEL-11): Librarians are built-in →
**disable-only**; Researchers/feeds the user adds → **removable** (with a destructive-action
confirm). The hub surfaces that difference (no Delete on a built-in librarian; Delete on a
user-added researcher).

> Open, non-blocking sub-question: whether the always-on pipeline librarians get any visual
> separation from user-addable items *within* the Librarians group. Defer to Design-Lead at build.

## 3. Consistency (independent of the fork)
Regardless of A/B/C, the Manage surfaces must share one design-system grammar (this is part of the
WS3 legacy-view cleanup): no native `<select>`, no hard-coded hex (Agents' running-status green →
`--viz-state-running`), consistent cards/segmented-controls, a11y labels.

## 4. Requirements (must unless noted) — `Verify: none-yet → test:`
- **AGENTSIA-1** The Manage section communicates the **three distinct kinds** (system pipeline
  workers vs outward researchers vs schedules) via labels + a one-line descriptor per section, so a
  first-time user can tell them apart without opening each. `Verify: agentsHubView.test (group heads + inward/outward descriptors + Schedules-under-Librarians)`
- **AGENTSIA-2** Naming is resolved per the chosen fork (default C: Agents→Librarians,
  Jobs→Schedules, Researchers unchanged) and applied consistently in nav, headers, and copy.
  `Verify: agentsHubView.test (Librarians/Researchers/Schedules headers) + glossary (SPEC-0001)`
- **AGENTSIA-3** The IA structure matches the chosen fork (**RESOLVED: one Agents hub** framed by
  direction — Librarians [+Schedules] / Researchers). `Verify: agentsHubView.test + navModel.test (single VIEW_AGENTS hub; Jobs+Researchers no longer rail siblings)`
- **AGENTSIA-4** All Manage views render on the **design system** — no native controls, no
  hard-coded hex, tokens only; a11y labels present. `Verify: agentsHubView.test (hub composes no native <select>)` — *partial: the hub + sections compose viz primitives; the pre-existing SPEC-0048 model-picker `.viz-select` is preserved (no engine change, AGENTSIA-5) and is tracked under WS3 cleanup.*
- **AGENTSIA-5** No behavioral/feature change to the underlying Agents/Researchers/Jobs engines —
  this is IA + naming + styling only. `Verify: by construction — each section is the existing view mounted unchanged; its component tests (agentsView/jobsView/researchersView.test) pass intact`
- **AGENTSIA-6** Any user-facing rename updates the glossary (SPEC-0001) so terminology stays
  ratified and consistent across surfaces. `Verify: SPEC-0001 glossary — Librarian (inward) + Researcher (outward) + Schedules (ex-Jobs) terms added`

## 5. Out of scope
- New agent/researcher/job capabilities (covered by their own specs).
- The deeper Control-Panel knobs (scale caps, model picker) — SPEC-0048.

## 6. Changelog
- 2026-06-27 — **built** by KB-Developer-4 (solo, after the paired DEV-6 half went unresponsive ~25m;
  declared full footprint on #control). One **Agents hub** (`agentsHubView`) composes the existing
  Agents/Jobs/Researchers views as in-place sections under two direction-framed groups — **Librarians**
  (inward; built-in→disable-only) with **Schedules** (ex-"Jobs") nested, and **Researchers** (outward;
  user-added→removable); nav consolidated (single `VIEW_AGENTS` rail item replacing the three Manage
  siblings); glossary (SPEC-0001) updated. IA + naming + composition only — **no engine change**: each
  section is the existing view mounted unchanged (its component tests pass intact), so a section that
  fails to load is isolated and the hub still renders. Gates: QD-2 code + DL-2 visual.
