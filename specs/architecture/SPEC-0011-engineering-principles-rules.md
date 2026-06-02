---
spec: SPEC-0011
key: ENG
title: Engineering Principles & Rules
type: architecture
status: active
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0000, SPEC-0002, SPEC-0010]
supersedes: null
---

# Engineering Principles & Rules

> How we **build** KB-App. Distinct from [SPEC-0002 Knowledge System Principles]
> (which are the *product's* values); these bind the *engineering*. A **living
> document** — we add principles (E-n) and rules (ENG-n) over time. Rules here are
> **active and binding now**, and summarized in the repo `CLAUDE.md` so they apply
> every session.

## 1. Intent

A long-lived, AI-built codebase needs durable, explicit engineering rules so quality
and safety don't erode as the surface grows and as different agents/sessions touch
it. These are checkable rules, not vibes — each has a stable ID and a verification
path, same as every other spec (SPEC-0000).

## 2. Principles & rules

### E1 — Dependency safety / supply-chain caution
There is an active wave of package-injection and supply-chain attacks (typosquatting,
compromised maintainer accounts, malicious post-install scripts). We treat every
dependency as attack surface and adopt conservatively.

| ID     | Priority | Rule                                                              | Verify |
| ------ | -------- | ---------------------------------------------------------------- | ------ |
| ENG-1  | must     | New deps MUST be well-established, widely used (high download counts), and reputable | manual:review |
| ENG-2  | must     | A dependency version MUST have been published **≥7 days** ago before adoption | manual:review |
| ENG-3  | may      | The 7-day window MAY be shortened **only** for an important security fix (CVE), with written justification | manual:review |
| ENG-4  | must     | Dependency versions MUST be pinned (exact / lockfile) so a caret can't pull an unreviewed or <7-day release | manual:review |
| ENG-5  | should   | Prefer fewer dependencies; each addition MUST be justified vs. writing it ourselves (ties PRIN-5) | manual:review |
| ENG-6  | should   | Adding/upgrading a dep SHOULD check peer-dependency compatibility before committing | manual:review |
| ENG-7  | may      | A **fast-moving / preview** package MAY be a critical dependency when justified (e.g. the **Copilot SDK**) — being preview/young-as-a-project is **not** itself disqualifying; ENG-1/2/4 still bind (vet, **≥7-day**, **pin**). The guard is supply-chain: **never adopt a release hot off the presses** | manual:review |

> Already applied: the Electron/TS toolchain was pinned to stable, ≥7-day-old versions;
> `@electron/fuses` held at v1 for peer compat; `eslint-plugin-import` dropped to reduce
> surface. Future: automate via a CI dependency-review / `npm audit` gate (ENG-5 none-yet).

### E2 — Testability & heavy testing investment
We invest **heavily** in tests to prevent regression and to make the spec's `Verify:`
methods real. Not tests for their own sake — every test asserts real,
requirement-backed behavior — but we want *thorough* coverage.

| ID     | Priority | Rule                                                              | Verify |
| ------ | -------- | ---------------------------------------------------------------- | ------ |
| ENG-7  | must     | Every user story/feature MUST have clear, addressable requirements (spec requirement IDs) | manual:review |
| ENG-8  | must     | Tests MUST trace to requirements; a requirement's `Verify:` graduates `none-yet → test:` when covered | none-yet |
| ENG-9  | must     | A story is "done" only when its `must` requirements have tests   | none-yet |
| ENG-10 | should   | Code coverage MUST be **very high** — target **≥90% lines** on domain/core logic | none-yet |
| ENG-11 | should   | Test volume is expected to approach **~1:1 with production LOC** (heuristic, not a gate) — driven by coverage of real behavior, never padding | none-yet |
| ENG-12 | must     | A bug fix MUST add a regression test reproducing the bug         | none-yet |
| ENG-13 | should   | Three levels (per Testing Strategy spec): **unit** (domain/code), **component** (UI), **e2e** (Playwright, incl. packaged-app smoke) | none-yet |
| ENG-14 | should   | The test suite gates merges (runs in CI / pre-merge)             | none-yet |

> Most E2 `Verify:` are `none-yet` until the **Testing Strategy** spec stands up the
> harness (Vitest + Playwright) and wires coverage thresholds. That spec makes these
> enforceable; this principle makes them required.

## 3. How this document grows

- Add a new principle as `### E-n — <name>` with rationale.
- Add rules as `ENG-n` (stable IDs, never reused), RFC-2119, with a `Verify:`.
- Mirror the **hard, always-on** rules into `CLAUDE.md` (keep it short; this spec is
  the canonical detail).

## 4. Open questions

- [ ] **Dependency automation** — which gate? (`npm audit` in CI, GitHub dependency-review
      action, a `socket.dev`-style scanner?) Pin when CI is set up.
- [ ] **Coverage enforcement** — exact thresholds per layer (domain vs. UI vs. e2e) and
      where they're configured (Vitest `coverage.thresholds`). Pin in Testing Strategy.
- [ ] **What counts as "production LOC"** for the ~1:1 heuristic (exclude generated/config?).

## 5. Changelog

- 2026-05-30 — created (active). E1 Dependency safety (ENG-1..6), E2 Testability
  (ENG-7..14). Mirrored hard rules into repo `CLAUDE.md`.
