---
spec: SPEC-0012
key: TEST
title: Testing Strategy
type: architecture
status: active
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0000, SPEC-0009, SPEC-0010, SPEC-0011]
supersedes: null
---

# Testing Strategy

> How we test KB-App: three levels (unit / component / e2e), a static-analysis gate,
> a **fast local loop** and a **thorough cross-platform CI gate** — the harness that
> lets every spec's `Verify:` graduate from `none-yet` to `test:`.

## 1. Intent (the why / JTBD)

[SPEC-0011 ENG E2] *requires* heavy, regression-proof testing and says a story is
"done" only when its `must` requirements have tests. That principle is currently
un-enforceable: there is no runner, no coverage gate, no CI, and every requirement in
the repo reads `Verify: none-yet`. This spec stands up the machinery that makes ENG E2
real and turns `specs/` into the **semantic test surface** SPEC-0000 describes — a place
where "do the tests cover the requirements?" has a mechanical answer.

The job this is hired for: **give the human + AI builders one fast check they run before
every change, and one authoritative check that gates every merge — both tracing back to
requirement IDs.** Without it, coverage is whatever was convenient, "is it still correct?"
is an opinion, and the specs drift from the code silently.

Two felt constraints shape the design:

- **The local loop must stay quick and lightweight.** Builders (and parallel agents) run
  it constantly; if it's slow they stop running it. So local excludes the slow, flaky-prone
  e2e layer.
- **Cross-platform correctness is non-negotiable but expensive.** The app ships on macOS
  **and** Windows (STACK-3); only CI has those machines. So the heavy, matrixed, e2e-inclusive
  suite lives in CI, not on the laptop.

## 2. Decisions

### The three levels

A pyramid, widest at the bottom:

- **Unit** — pure logic with **no Electron, no real filesystem/git/network**. Targets the
  TS domain (`app/src/kb/`: vault model, copilot detection parsing, types/guards) and any
  pure helpers extracted from the main process. Fast, deterministic, the **bulk** of tests
  and where the coverage bar bites (TEST-12).
- **Component** — a UI unit (a renderer view/widget) mounted in isolation with a **stubbed
  preload bridge**, asserting DOM/state. **Reserved for now** (TEST-5): the renderer is
  vanilla TS and likely to be rebuilt under a UI framework; a jsdom harness today risks
  being thrown away. Defined here so the level exists, but its requirements stay `none-yet`
  until a framework is chosen. The real UI is covered by e2e meanwhile.
- **e2e** — Playwright drives the **real Electron app** end-to-end (first target: the
  SPEC-0009 Setup flow), plus a **packaged-app smoke** that launches the built artifact and
  asserts it boots. Few, high-value, slow; **CI-only** (excluded from the local loop).

### Test runner — Vitest

The unit/component runner is **Vitest**.
- **Why:** native to the existing Vite toolchain (STACK) — shares transform/config, no
  second bundler to reconcile; fast watch mode; first-class TS/ESM; built-in coverage
  (v8); `node` and `jsdom`/`happy-dom` environments (the latter ready for the component
  tier when it lands). Avoids a Jest + ts-jest + separate-transform stack (ENG-5: fewer deps).
- **Tradeoff:** newer than Jest. Accepted — it is now mainstream, and the Vite alignment is
  decisive. Added per ENG E1 (reputable, pinned, ≥7-day-old version).

Main-process code that touches Electron APIs (`app`, `dialog`, `ipcMain`) is kept thin and
its **logic extracted into pure modules** so it is unit-testable without launching Electron;
the Electron-bound wiring itself is covered by e2e.

### e2e — Playwright driving Electron

e2e uses **Playwright** via its Electron support (`_electron.launch`) to drive the actual
app, not a mocked shell. It exercises real user flows (Setup first-run SETUP-1..6; the
returning-launch "no re-onboarding" path SETUP-6) and includes a **packaged-app smoke**
(ENG-13) so we catch breakage that only appears in the built `.app`/`.exe` (e.g. asar/dep
bundling — a known footgun called out in the repo `CLAUDE.md`).

e2e and any test that touches a vault **MUST** operate on a **throwaway vault in a temp
directory**, never the app's own repo (STACK-8).

### Component tier — reserved until a UI framework

Per the decision above, the component level is specified but **dormant**: TEST-5 holds it
at `none-yet`. When a UI framework is adopted (or we deliberately commit to testing the
vanilla renderer), we revisit, pick the environment (`happy-dom`/jsdom), and graduate
TEST-5 + add concrete component requirements. Until then, **do not** build a speculative
component harness.

### Static analysis & lint (the always-on gate)

Two non-test checks run alongside tests, both locally and in CI:

- **Typecheck** — `tsc --noEmit` (`npm run typecheck`) **MUST** pass with zero errors
  (TEST-7). Already wired.
- **Lint** — **ESLint 9 flat config** (`app/eslint.config.mjs`, already present): `@eslint/js`
  recommended + `@typescript-eslint` recommended, non-type-aware for speed. Lint **MUST**
  report **zero errors** (TEST-6). To prevent "warning rot," **CI runs `eslint` with
  `--max-warnings 0`** (TEST-8) — a warning that lingers becomes a CI failure, forcing it to
  be fixed or explicitly downgraded in config.
- **Formatting** — deliberately **not** adopting a formatter (Prettier) yet; it's a new dep
  and ESLint + editor settings suffice for now. Tracked in Open Questions.

### Local vs CI — fast loop, full gate

This is the core split.

**Local — the quick suite (`/validate`):** `typecheck` + `lint` + **unit** (+ component
once it exists). **No e2e.** It is the gate builders and agents run before every PR.
- **No git hooks.** Enforcement is the `/validate` skill, not a committed pre-commit/pre-push
  hook — that keeps the dependency surface at zero (ENG-5) and matches how agents already
  work. CI is the hard gate; local is the fast feedback loop.

**CI — GitHub Actions, the authoritative gate (ENG-14):** the **full** suite — typecheck +
lint (`--max-warnings 0`) + unit + component + **e2e + packaged smoke** — and it **gates
merges to `main`** via required status checks. CI is where the cross-platform matrix lives.

**Cross-platform matrix — goal vs. current practice (honest, no silent caps):**
- **Goal / target state:** a **full matrix** — every level (unit + component + e2e +
  packaged smoke) on **macOS and Windows**, the two shipped targets (STACK-3). Both
  platforms get everything.
- **Current practice (phased rollout):** we start narrow — in practice likely **unit tests
  on a single Linux runner** — and **build out toward the full matrix** as suites and the
  e2e harness mature. Linux is a cheap, fast runner for platform-agnostic unit tests; it is
  **not** a shipped target, so e2e ultimately runs on macOS + Windows.
- The CI workflow **MUST document what the matrix does and does not yet cover** (TEST-11),
  so a green check is never mistaken for "fully cross-platform verified" before it is.

### Coverage policy

- **Domain/core (`app/src/kb/`): target ≥90% lines** (ENG-10), enforced via Vitest
  `coverage.thresholds`; below threshold **fails CI** (TEST-12). The bar is enforced
  per-directory so untested glue elsewhere can't mask a gap in core.
- **Main-process glue:** lower bar (**SHOULD ≥70%**) — much of it is thin Electron wiring
  better covered by e2e (TEST-13).
- **Component/renderer:** no line threshold while the tier is reserved (TEST-13).
- **e2e:** judged by **flow coverage** (which user flows / requirement IDs are exercised),
  not line %.
- ENG-11's "~1:1 test:prod LOC" is a **heuristic, never a gate** — coverage of real behavior
  drives volume; padding is explicitly disallowed.

### Layout & naming

- Unit/component tests **colocated** with source as `*.test.ts` (e.g.
  `app/src/kb/vault.test.ts`).
- e2e under `app/e2e/*.e2e.ts`; Playwright config `app/playwright.config.ts`.
- Shared fixtures/helpers under `app/test/` (e.g. a temp-vault factory, a preload-bridge stub).
- Vitest config `app/vitest.config.ts`; scripts: `npm test` (unit/component, watch off),
  `npm run test:e2e` (Playwright). `/validate` runs typecheck + lint + `npm test`.

### Requirement traceability

The point of all this (SPEC-0000):
- A test **SHOULD** name the requirement ID(s) it covers — in the `describe`/`it` title or a
  comment (e.g. `it('SETUP-3: initializes git when root is not a repo', …)`) — so coverage
  is greppable by ID (TEST-14).
- When a requirement gains a passing test, its `Verify:` graduates `none-yet → test:<path>`
  **in the same change** (ENG-8, SPECSYS-7).
- A `must` requirement is "done" only with a passing test backing it (ENG-9, TEST-15); a bug
  fix **MUST** add a regression test reproducing the bug first (ENG-12, TEST-16).

## 3. Requirements

| ID       | Priority | Statement (short)                                                                 | Verify        | Traces |
| -------- | -------- | --------------------------------------------------------------------------------- | ------------- | ------ |
| TEST-1   | must     | Testing has three levels — unit, component, e2e — with the roles defined here     | manual:review | ENG-13 |
| TEST-2   | must     | Unit tests target domain/core with no Electron or network; FS/git is stubbed or confined to a temp dir | test:app/src/kb | ENG-10 |
| TEST-3   | must     | The unit/component runner is Vitest (Vite-native)                                 | test:app/vitest.config.ts | STACK-1 |
| TEST-4   | must     | e2e uses Playwright to drive the real Electron app, incl. a packaged-app smoke    | none-yet      | ENG-13; STACK-3 |
| TEST-5   | should   | The component tier is reserved (`none-yet`) until a UI framework is chosen         | manual:review | ENG-13 |
| TEST-6   | must     | ESLint (flat config) reports zero errors                                          | test:.github/workflows/ci.yml | ENG-14 |
| TEST-7   | must     | `tsc --noEmit` typecheck passes clean                                             | test:.github/workflows/ci.yml | ENG-14 |
| TEST-8   | should   | CI runs ESLint with `--max-warnings 0` (no warning rot)                           | test:.github/workflows/ci.yml | ENG-14 |
| TEST-9   | must     | The local quick suite (`/validate`) = typecheck + lint + unit (+ component); NO e2e; no git hooks | manual:review | ENG-14 |
| TEST-10  | must     | CI (GitHub Actions) runs the full suite incl. e2e and gates merges to `main`      | none-yet      | ENG-14 |
| TEST-11  | should   | CI targets a full macOS+Windows matrix; rollout is phased and the workflow documents current coverage (no silent caps) | manual:review | STACK-3 |
| TEST-12  | must     | Domain/core coverage ≥90% lines, enforced via Vitest thresholds; below fails CI   | test:app/vitest.config.ts | ENG-10 |
| TEST-13  | should   | Per-layer coverage: main-process ≥70%; component/renderer no threshold while reserved | manual:review  | ENG-10 |
| TEST-14  | should   | Tests reference the requirement ID(s) they cover (greppable by ID)                | manual:review | ENG-8; SPECSYS-8 |
| TEST-15  | must     | A `must` requirement's `Verify:` graduates `none-yet → test:` in the same change that covers it | manual:review | ENG-8,9; SPECSYS-7 |
| TEST-16  | must     | A bug fix adds a regression test reproducing the bug                              | manual:review | ENG-12 |
| TEST-17  | should   | Tests are laid out as `*.test.ts` colocated; e2e under `app/e2e/`; fixtures under `app/test/` | manual:review | — |
| TEST-18  | must     | Tests that touch a vault use a throwaway temp vault, never the app's own repo     | test:app/test/tempVault.ts | STACK-8 |
| TEST-19  | must     | Test-tooling dependencies follow ENG E1 (reputable, pinned, ≥7-day-old)           | manual:review | ENG-1..4 |

### TEST-1 — Three levels, defined roles
- **Status:** draft · **Priority:** must
- **Statement:** The strategy **MUST** comprise three levels — **unit** (pure domain/code),
  **component** (UI unit in isolation), and **e2e** (Playwright driving the real app) — each
  with the role defined in §2.
- **Rationale:** A shared vocabulary for where a given behavior is tested; prevents everything
  collapsing into slow e2e or shallow unit-only coverage.
- **Traces:** ENG-13 · **Verify:** manual:review

### TEST-2 — Unit tests are pure and fast
- **Status:** active · **Priority:** must
- **Statement:** Unit tests **MUST** exercise domain/core logic with **no** Electron and **no**
  network; filesystem/git effects **MUST** be either stubbed or **confined to a throwaway temp
  dir** (TEST-18), never shared/global state or the user's environment beyond `git` on PATH.
- **Rationale:** Speed and determinism keep the bulk layer runnable on every change. Logic whose
  *job* is the filesystem/git (vault setup) is only meaningfully tested against real FS/git, so
  we keep it hermetic via temp dirs rather than mocking simple-git into a brittle fiction.
- **Refined (impl):** the original "no real FS/git" was relaxed to "temp-dir-confined" after
  implementing `vault.test.ts` — mocking simple-git tested nothing real.
- **Traces:** ENG-10 · **Verify:** test:app/src/kb (`vault.test.ts`, `copilot.test.ts`)

### TEST-3 — Vitest is the runner
- **Status:** active · **Priority:** must
- **Statement:** The unit/component runner **MUST** be Vitest, configured to share the Vite
  toolchain.
- **Rationale:** One transform/config, native TS/ESM, built-in coverage, fewer deps than a
  Jest stack (ENG-5).
- **Note:** pinned `vitest@3.2.4` (not 4.x) — Vitest 4 requires Vite ^6/7/8, but the app is on
  Vite 5 via electron-forge (ENG-6 peer check). 3.2.4 accepts Vite 5 and dedupes.
- **Traces:** STACK-1 · **Verify:** test:app/vitest.config.ts

### TEST-4 — e2e drives the real app
- **Status:** draft · **Priority:** must
- **Statement:** e2e **MUST** use Playwright to launch and drive the real Electron app, and
  **MUST** include a packaged-app smoke test that boots the built artifact.
- **Rationale:** Only the real (and packaged) app catches IPC, window lifecycle, and
  asar/dep-bundling failures that unit tests can't see.
- **Status (impl):** scaffolded — `app/playwright.config.ts` + `app/e2e/smoke.e2e.ts` launch
  the packaged app with a clean `--user-data-dir` and assert the first-run Setup UI (SETUP-1).
  Stays `none-yet` until it has run green in CI on macOS/Windows (phased rollout, opt-in job).
- **Traces:** ENG-13, STACK-3 · **Verify:** none-yet *(scaffold present; pending first green run)*

### TEST-5 — Component tier reserved
- **Status:** draft · **Priority:** should
- **Statement:** The component level **SHOULD** remain `none-yet` (no harness built) until a
  UI framework is chosen or we explicitly decide to test the vanilla renderer.
- **Rationale:** Avoid investing in a jsdom harness likely to be discarded in a UI rewrite;
  e2e covers the real UI meanwhile.
- **Traces:** ENG-13 · **Verify:** manual:review

### TEST-6 — Lint is clean
- **Status:** draft · **Priority:** must
- **Statement:** `eslint .` (the flat config in `app/eslint.config.mjs`) **MUST** report zero
  errors as part of validation.
- **Rationale:** Static analysis catches a class of defects before tests run, cheaply.
- **Traces:** ENG-14 · **Verify:** test:.github/workflows/ci.yml (lint step)

### TEST-7 — Types check clean
- **Status:** draft · **Priority:** must
- **Statement:** `tsc --noEmit` **MUST** pass with zero errors as part of validation.
- **Rationale:** The type system is the first and cheapest test; a red typecheck blocks merge.
- **Traces:** ENG-14 · **Verify:** test:.github/workflows/ci.yml (typecheck step)

### TEST-8 — No warning rot
- **Status:** draft · **Priority:** should
- **Statement:** CI **SHOULD** invoke ESLint with `--max-warnings 0` so warnings cannot
  accumulate unaddressed.
- **Rationale:** Warnings that never fail anything are ignored forever; CI forces a decision
  (fix or downgrade the rule deliberately).
- **Traces:** ENG-14 · **Verify:** test:.github/workflows/ci.yml (`lint -- --max-warnings 0`)

### TEST-9 — Fast local loop
- **Status:** draft · **Priority:** must
- **Statement:** The local quick suite (run via `/validate`) **MUST** be typecheck + lint +
  unit tests (+ component when it exists) and **MUST NOT** include e2e; it **MUST NOT** rely
  on a committed git hook.
- **Rationale:** A loop builders run constantly must be fast and dependency-free; e2e and
  cross-platform belong in CI.
- **Traces:** ENG-14 · **Verify:** none-yet

### TEST-10 — CI is the hard gate
- **Status:** draft · **Priority:** must
- **Statement:** GitHub Actions **MUST** run the full suite (typecheck, lint, unit,
  component, e2e, packaged smoke) and **MUST** be a required check that gates merges to `main`.
- **Rationale:** Local is fast-but-partial; only CI runs the slow, matrixed, authoritative
  suite that defines "mergeable."
- **Status (impl):** `.github/workflows/ci.yml` runs the gating `quick` job (typecheck + lint +
  unit + coverage). The "gates merges to `main`" half still needs **branch-protection / required
  status checks** enabled in repo settings — a follow-up, hence still `none-yet`.
- **Traces:** ENG-14 · **Verify:** none-yet *(workflow present; required-check enforcement pending)*

### TEST-11 — Cross-platform matrix, honest rollout
- **Status:** draft · **Priority:** should
- **Statement:** CI **SHOULD** target a full **macOS + Windows** matrix running all levels;
  the rollout **MAY** be phased (starting with unit on a single runner), and the workflow
  **MUST** document what the matrix currently does and does not cover.
- **Rationale:** Cross-platform is the goal (STACK-3), but a partial early matrix must not be
  mistaken for full verification — silent caps read as "covered" when they aren't.
- **Traces:** STACK-3 · **Verify:** none-yet

### TEST-12 — Core coverage bar
- **Status:** draft · **Priority:** must
- **Statement:** Domain/core (`app/src/kb/`) line coverage **MUST** be **≥90%**, enforced via
  Vitest `coverage.thresholds`; falling below **MUST** fail CI.
- **Rationale:** Makes ENG-10 real and per-directory, so the core can't hide gaps behind
  well-covered glue.
- **Status update:** active — `coverage.include` is scoped to `src/kb/**`; first green run at
  91.8% lines / 100% functions / 87.8% branches.
- **Traces:** ENG-10 · **Verify:** test:app/vitest.config.ts (`coverage.thresholds`)

### TEST-13 — Per-layer coverage
- **Status:** draft · **Priority:** should
- **Statement:** Main-process code **SHOULD** target ≥70% lines; component/renderer **SHOULD**
  carry no line threshold while the component tier is reserved.
- **Rationale:** Thresholds match each layer's testability; an impossible bar on Electron glue
  just produces gamed tests.
- **Traces:** ENG-10 · **Verify:** none-yet

### TEST-14 — Tests name their requirements
- **Status:** draft · **Priority:** should
- **Statement:** A test **SHOULD** reference the requirement ID(s) it verifies in its title or
  a comment, so coverage is greppable by ID.
- **Rationale:** This is what makes `specs/` a mechanically checkable surface (SPECSYS-8).
- **Traces:** ENG-8, SPECSYS-8 · **Verify:** manual:review

### TEST-15 — Verify graduates with coverage
- **Status:** draft · **Priority:** must
- **Statement:** When a requirement gains a passing test, its `Verify:` **MUST** change
  `none-yet → test:<path-or-id>` in the **same** change set.
- **Rationale:** Anti-drift: coverage and the spec's claim about coverage move together
  (ENG-8/9, SPECSYS-7).
- **Traces:** ENG-8, ENG-9, SPECSYS-7 · **Verify:** manual:review

### TEST-16 — Regression test on bug fix
- **Status:** draft · **Priority:** must
- **Statement:** A bug fix **MUST** include a test that reproduces the bug (fails before the
  fix, passes after).
- **Rationale:** Prevents silent re-introduction; encodes the bug as a permanent guard.
- **Traces:** ENG-12 · **Verify:** manual:review

### TEST-17 — Layout & naming
- **Status:** draft · **Priority:** should
- **Statement:** Unit/component tests **SHOULD** be colocated as `*.test.ts`; e2e specs
  **SHOULD** live under `app/e2e/`; shared fixtures under `app/test/`.
- **Rationale:** Predictable locations keep tests discoverable and the runner globs simple.
- **Traces:** — · **Verify:** manual:review

### TEST-18 — Never test against the app repo
- **Status:** draft · **Priority:** must
- **Statement:** Any test that touches a vault **MUST** use a throwaway vault in a temp
  directory and **MUST NOT** operate on the app's own source repo.
- **Rationale:** The app repo is app source, not a KB (STACK-8); a test writing to it could
  corrupt the working tree or commit garbage.
- **Traces:** STACK-8 · **Verify:** test:app/test/tempVault.ts (used by `vault.test.ts`)

### TEST-19 — Test deps follow supply-chain rules
- **Status:** draft · **Priority:** must
- **Statement:** Test-tooling dependencies (Vitest, Playwright, coverage providers, etc.)
  **MUST** follow ENG E1 — reputable, widely used, version pinned, and ≥7 days old.
- **Rationale:** Dev/test deps are attack surface too; the install runs on builder and CI
  machines.
- **Traces:** ENG-1, ENG-2, ENG-4 · **Verify:** manual:review

## 4. Open questions

- [ ] **Formatter** — adopt Prettier (consistency, but a new dep + ESLint integration) or stay
      ESLint-only? Leaning ESLint-only until the team grows. Revisit if style churn appears in diffs.
- [ ] **happy-dom vs jsdom** — decide when the component tier activates (TEST-5); happy-dom is
      faster, jsdom more complete. No-op until then.
- [x] **Coverage provider** — **resolved: `v8`** (fast, native; accurate enough here). Revisit
      only if remapping proves inaccurate.
- [x] **e2e target** — **resolved (for the smoke): the packaged artifact**, launched with a clean
      `--user-data-dir` to force first-run. Dev-build flow tests may be added later for speed;
      the authoritative smoke stays on the packaged app.
- [ ] **Coverage of generated/config files** — what's excluded from the "production LOC" the
      ~1:1 heuristic (ENG-11) measures against? Pin an exclude list in `vitest.config.ts`.
- [ ] **CI dependency gate** — fold an `npm audit` / dependency-review step into the same
      workflow (ENG open question) or keep separate? Decide when CI is authored.
- [ ] **When does the component tier activate** — tied to the eventual UI-framework decision
      (STACK open questions / future PANEL/Setup UI work).

## 5. Changelog

- 2026-05-30 — **harness implemented** (status → active). Vitest 3.2.4 + @vitest/coverage-v8 +
  Playwright 1.60.0 (pinned, ≥7-day-old, ENG E1). `app/vitest.config.ts` gates `src/kb` ≥90%
  (first run 91.8% lines); `vault.test.ts` + `copilot.test.ts` cover SETUP-3/4/5 (graduated to
  `test:`). Playwright scaffold + packaged boot smoke (`e2e/`, SETUP-1, still `none-yet` pending
  first green run). `.github/workflows/ci.yml` gating `quick` job + opt-in e2e matrix (phased,
  TEST-11). `/validate` aligned to exclude e2e (TEST-9). Refined TEST-2 (temp-dir-confined FS/git).
  Resolved open Qs: coverage provider `v8`, e2e target = packaged. Remaining `none-yet`: TEST-4
  (e2e green), TEST-10 (branch-protection required-check).
- 2026-05-30 — created (draft). Establishes the three-level model (unit/component/e2e),
  Vitest + Playwright, the lint/typecheck static gate, the fast-local (`/validate`, no e2e,
  no hooks) vs full-CI (GitHub Actions, e2e, mac+Windows matrix goal with phased rollout)
  split, per-layer coverage policy (≥90% core), and the requirement-traceability convention
  that graduates `Verify: none-yet → test:`. Makes SPEC-0011 E2 enforceable.
