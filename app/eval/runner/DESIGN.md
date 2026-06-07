# SPEC-0042 EVAL — Slice 1 (harness core) — design draft + fork recommendations

> **Status: DRAFT for KB-Lead ratification (forks) — NOT code-locked.** Per the dispatch, this captures
> the Slice-1 architecture + recommend-with-rationale on the open forks. Deep/fork-dependent
> implementation (Dockerfile egress posture, the in-process driver wiring, cred plumbing) lands only
> after KB-Lead ratifies the forks below. PR routes to KB-Lead (product + forks) + KB-QD (gate-2).

## Slice-1 scope (from SPEC-0042 §6)

Container image + scenario schema/loader + action driver + **deterministic** validator library +
scorecard; **one real enrich scenario end-to-end**, generalizing today's `eval/enrichE2eDogfood`.
Resolves fork #1 (action-driver fidelity).

## Module layout (`app/eval/runner/`)

- `scenario.ts` — Scenario **types + schema validation** (EVAL-1). A malformed scenario fails fast with
  a clear error, never a partial run. Pure, fork-independent.
- `loader.ts` — read a YAML scenario file → validate → typed `Scenario`. (Needs a YAML parser — see
  "Dependency" below.)
- `actions.ts` — the **ActionDriver seam**: maps each real verb (`ingest`/`ask`/`runJob`/
  `dispatchResearcher`/`setConfig`/`awaitDrain`) to the real pipeline. **Fork #1 lives here** — the
  in-process implementation (`inProcessDriver.ts`) vs a future IPC driver both satisfy this interface.
- `snapshot.ts` — capture the resulting vault state (entities / claims / sources / recall / audit /
  spans) into a plain `VaultSnapshot` the validators read. Fork-independent.
- `validators.ts` — the **deterministic check library** (EVAL-3): named, parameterized checks over a
  `VaultSnapshot` (entitiesInclude/Exclude, claimCitations, recallCites, countBounds, auditEvents,
  wikilink-rendered, …). Pure, fork-independent. Generalizes the hand-wired asserts in
  `enrichE2eDogfood`.
- `scorecard.ts` — structured scorecard (scenario × variant → deterministic pass/fail) + a
  human-readable summary (EVAL-8). Baseline diffing is Slice-2/3; Slice-1 emits the scorecard shape.
- `runScenario.ts` — the runner: provision clean KB → apply seed → drive actions via the ActionDriver →
  snapshot → run deterministic validators → emit scorecard. Injects ULID/clock seeds (EVAL-2/SPEC-0011)
  so the model output is the single measured variable.
- `../scenarios/enrich.yaml` — the one real Slice-1 scenario (the enrich flow as declarative data).
- `../Dockerfile` — clean-world image (node + pinned deps + BYOA `copilot` CLI + git) (EVAL-5).

### Action verb → real pipeline mapping (in-process, fork #1 lean)

| verb | real call (from `enrichE2eDogfood`, generalized) |
| --- | --- |
| `ingest` | `Orchestrator.capture()` → `poke()` (archive → sources/ → decompose queue) |
| `awaitDrain` | per stage: `decomposeOne` over `readDecomposeQueue`; `ConnectStage.poke()`; `ClaimsStage.poke()`; settle link-promotion |
| `ask` | `recall(root, query, { cliPath })` |
| `runJob` | the SPEC-0023 `JobScheduler` tick for the named job |
| `dispatchResearcher` | `runResearcherNow` / the researcher dispatcher (egress under fork #3) |
| `setConfig` | `setResearcherConfig` / job config patch |

The deciders are the **real** `makeXDecider()` (BYOA copilot) — never mocked (EVAL-2).

## Fork recommendations (KB-Lead ratifies)

**Fork #1 — action-driver fidelity → RECOMMEND: in-process pipeline modules in the container** (confirms
KB-Lead's lean). The cognition (prompts/tools/model via `makeXDecider`) is **byte-identical** whether
driven in-process or over IPC — the model-under-test is the same, so EVAL-2 ("never mock the model") is
satisfied either way. In-process is far simpler (no packaged-app boot/IPC harness), is exactly what
`enrichE2eDogfood` already does (so Slice-1 is a generalization, not a rewrite), and is parallel-safe.
The driver is an **interface seam**, so a packaged-app-over-IPC driver can be added later if a
surface-level eval ever needs black-box fidelity — without touching scenarios or validators.

**Fork #3 — egress → RECOMMEND: record/replay (cassette) default, `--live` to refresh** (confirms lean).
Deterministic scoring requires a stable external world; the live web drifts, so live-by-default makes
RESEARCH evals non-reproducible (can't tell a prompt regression from a web change). Record once with
`--live` (real egress, writes a cassette carrying **no secrets/PII** — EVAL-6), replay deterministically
by default. *Slice-1 note:* the enrich scenario is internal-cognition only (no external egress), so the
record/replay LAYER is **Slice-3** (EVAL-6); Slice-1 just doesn't run a live-egress scenario. I'll land
the egress seam's interface in Slice-1 so Slice-3 slots in, but not the cassette store.

**Fork #4 — eval credentials → RECOMMEND: runtime-injected, never baked into the image** (my rec, per
AUTO-11). The `eval/Dockerfile` contains **no creds**; scoped BYOA creds (a dedicated eval `copilot`
token, eval-only `gh`/`az` if a scenario needs them) are passed at run time via env/mounted secret
(CI secret store locally → `--env`/`--secret`; never `ARG`/`ENV` baked, never committed). This keeps
AUTO-11 ("no stored secrets") + EVAL-11 ("scoped eval creds only, never the Principal's") intact and the
image freely shareable. The image build needs **no** creds; only `docker run` does.

**Fork #2 — judge-model pinning → DEFER to Slice 2** (per dispatch). Slice-1 is deterministic validators
only; the agent-judge + its pinned-model/version-record (EVAL-4/9) land with Slice-2.

## Dependency (E1 supply-chain)

Slice-1 needs a YAML parser (`js-yaml`) for declarative scenarios (EVAL-1). Recommend **`js-yaml`,
pinned, ≥7-day-aged, no hot-off-the-press release** (E1). It's `eval/`-only (a devDependency), not in the
shipped app. Flagging for the dep-guard; will pin the exact version in the impl PR.

## What's drafted now vs. after ratification

- **Now (fork-independent, this draft):** module layout, `scenario.ts` types + schema, the `enrich.yaml`
  scenario, the ActionDriver **interface**, validator-library + scorecard **shapes**.
- **After KB-Lead ratifies (deep):** the in-process driver wiring to the real pipeline, the full
  deterministic validator library + scorecard, the `Dockerfile`, the YAML dep pin, tests
  (schema-validation + each validator + the enrich scenario end-to-end), full validate → PR.
