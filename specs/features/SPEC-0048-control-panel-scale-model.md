---
spec: SPEC-0048
key: SCALE
title: Control Panel — user-configurable scale (per-stage caps + global ceiling) & model selection
type: feature
status: draft
owners: [KB-Lead, Principal]
related: [SPEC-0014, SPEC-0010, SPEC-0033, SPEC-0030, SPEC-0047]
created: 2026-06-13
stage: Cross-cutting
supersedes: null
---

# Control Panel — user-configurable scale & model

> The engine already HAS the knobs (per-stage concurrency cap ORCH-20, global Copilot ceiling
> ORCH-23, model resolution ORCH-16/28) — they're just **hardcoded / auto-derived with no UI**.
> Expose them to the Principal. Today the auto-defaults **starve downstream stages** and there's no
> way to pick a model. Put both under the Principal's control.

## 1. Intent (the why / JTBD)

Observed live (kb-test-1, 2026-06-13): global ceiling auto-derived to **4** (16-core box →
`max(2,min(4,cores-1))`), Decompose hardcoded at cap **3** + Connect **1** = **4** = the whole
ceiling → **Claims & Compose starve to zero slots and read BLOCKED** while Decompose churns. The
Principal can't fix it: the ceiling is auto-set (`KB_COPILOT_MAX_CONCURRENCY` env only, never set by
the app), per-stage caps are one hardcoded `STAGE_CAP=3`, and the model is auto-resolved with no
picker. JTBD: *"let me tune how hard the machine runs — total throughput and which stages get the
juice — and pick the model, without editing code or env."*

## 2. Current state (what exists to expose)

- **Per-stage cap** — `DEFAULT_STAGE_CAP`; pipeline.ts sets `STAGE_CAP=3` for Decompose/Claims/
  Compose, Connect & Archive = 1. cap>1 runs N items' cognition concurrently (own worktrees,
  advances serialized under the lock). *Hardcoded.*
- **Global ceiling** — `copilotConcurrency.resolveCeiling()`: env `KB_COPILOT_MAX_CONCURRENCY` else
  `max(2,min(4,cores-1))`. Bounds total in-flight copilot subprocesses. *Auto; app never sets it.*
- **Model** — `resolveCopilotModel()` (floor 4.5 + `help config` probe → opus-4.8 ladder, ORCH-28);
  Agents view (`listAgentsForActive`) lists deciders/researchers/jobs but offers no model choice.
- **Settings store** — `instanceConfig` (`.kb/instance.json`, per-vault, Settings-owned). Has NO
  scale or model keys today. Visual lane = SPEC-0033 / Control Panel (Design-Lead).

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`

**Scale:**
- **SCALE-1** Global Copilot ceiling is a Settings value (`instance.json`), default = the current
  cores-derived value, range-clamped (≥1, sane upper bound). Env still overrides for tests/measure.
- **SCALE-2** Per-stage concurrency cap is configurable **per stage** (Decompose/Connect/Claims/
  Compose/Archive), persisted in `instance.json`, each defaulting to today's value.
- **SCALE-3** **No-starvation guard:** the UI/engine prevents (or clearly warns) a config where
  upstream caps sum to ≥ the ceiling and leave a downstream stage 0 reserved slots — the exact
  BLOCKED-Claims pathology. Either a per-stage *reservation* or a validation warning at set-time.
  *(should — pick one; reservation preferred so a sensible default "just works".)*
- **SCALE-4** Changing a scale setting applies without a reinstall (live re-read or on next
  sweep/restart; state the chosen semantics).
- **SCALE-5** Connect's cap can exceed 1 only after its ephemeral-worktree migration (Phase 2); until
  then the UI pins Connect at 1 with a note. *(constraint)*
- **SCALE-6** The ceiling has two modes via a **"Let the app decide"** checkbox: **manual** (the
  Principal sets an explicit number — the interim toggle) vs **auto/adaptive** (SCALE-7). Manual is
  the v1 must; auto is the better default once SCALE-7 lands.
- **SCALE-7** **Adaptive ceiling (the real fix):** in auto mode the app treats **rate-limit (429)
  errors as the control signal** — additive-increase the live ceiling while healthy, multiplicative-
  decrease on a 429/rate-limit, then periodically re-probe upward (AIMD / congestion-control). It
  must **classify rate-limit errors distinctly** from content errors (e.g. the truncated-JSON class)
  so it only backs off on real throttling — the #341 error-in-telemetry messages enable this. The
  artificial `min(4, cores-1)` clamp is removed; cores-derived is only the *starting* guess.
- **SCALE-8** The live **resolved ceiling** + a **"throttled (rate limits)"** indicator (and optional
  suggestion, e.g. "settling around N") are surfaced in the Control Panel/Status, so the Principal
  sees the machine finding its own limit rather than a static number. *(should)*

**Model:**
- **MODEL-1** The Agents view offers a **model picker** whose options are the **CLI's actually-
  accepted models** (from the `help config` catalog / pre-flight probe — never a hardcoded list that
  can drift, per the ORCH-28 lesson).
- **MODEL-2** Selection persists in `instance.json` and feeds `resolveCopilotModel` as an explicit
  override (above the auto ladder, still validated against the probe; invalid → fall back + warn).
- **MODEL-3** Scope = global default with optional per-agent override (deciders/researchers/jobs).
  *(per-agent override = should; global = must.)*
- **MODEL-4** The **resolved** model is shown in the Agents view (builds on the ORCH-16 trace), so
  the Principal sees what actually ran, not just what was requested.

## 4. Out of scope / notes
- The richer "let-it-race + reconciliation" stage concurrency (SPEC-0044 / #283) is orthogonal; this
  spec only exposes the existing cap+ceiling model.
- Visual design of the Control Panel + Agents-view picker = Design-Lead (SPEC-0033 gate).
