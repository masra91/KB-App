# Evals & Scenario Harness (`eval/`)

The **quality** check for the KB's non-deterministic cognition (Decompose, Connect, Claims,
Recall, Researchers, Reflect, Jobs). Unit/e2e tests (SPEC-0012) prove the *mechanism*
deterministically; **EVAL measures the quality the mechanism can't** — "did Decompose pick the
right granularity?", "is this finding substantive?", "did Recall answer correctly and ground it?".

You give a **scenario** (a seeded KB + a script of real actions + validators); the harness
provisions an isolated clean-world KB, drives the actions **through the real pipeline/cognition**
(it never mocks the model-under-test), snapshots the result, scores it (deterministic *and/or*
agent-judged), and diffs against a baseline. Spec: **SPEC-0042 (EVAL)**.

> A case is **declarative data** — a YAML file + named checks. Authoring one needs **no harness
> code** (EVAL-12). Add `eval/scenarios/<name>.yaml` and it's in the library.

---

## Authoring a case

Create `eval/scenarios/<name>.yaml`. Five parts:

```yaml
id: my-case                   # unique id
capability: recall            # ingest|decompose|connect|claims|recall|research|reflect|jobs
seed:
  kind: empty                 # empty | files | snapshot
  # ref: my-fixture           # kind:files → seed from eval/fixtures/my-fixture/ (entities, .kb/
                              #   researchers/registry.json, .kb/jobs/registry.json, sources, …)
actions:                      # the KB's REAL verbs, in order, against real cognition
  - ingest:     { text: "Python was created by Guido van Rossum and first released in 1991." }
  - awaitDrain:  { stages: [decompose, connect, claims] }
  - ask:        { query: "Who created Python?" }
expect:
  deterministic:              # exact pass/fail checks (the validator menu below)
    - check: recallCites
      args: { min: 1 }
    - check: recallContains
      args: { text: "Guido" }
  judge:                      # fuzzy quality — a pinned judge model (≠ the SUT) scores [0,1]
    - rubric: "Is the answer correct (Guido van Rossum), grounded in the KB, and cited? 1.0 only if all three."
      runs: 3
      threshold: 0.8          # passes iff mean(scores) ≥ threshold
variants:                     # OPTIONAL — cross-product of config overrides, scored per variant
  - { promptVersion: decompose/v2 }
  - { promptVersion: decompose/v3 }
```

**Rule of thumb:** assert with a **deterministic** check anything you can name exactly (an entity
exists, a citation is present, a count is bounded); use a **judge** rubric for the fuzzy quality a
check can't capture. Most good cases use both. `recall.yaml` is the canonical template.

### The action verbs (`actions:`)

Each maps to the **real** pipeline/IPC path — the cognition is identical to production.

| verb | args | does |
| --- | --- | --- |
| `ingest` | `{ text }` | capture a primary source onto the INGEST spine |
| `awaitDrain` | `{ stages: [decompose, connect, claims] }` | block until the named stages quiesce |
| `ask` | `{ query }` | run grounded recall; result lands in the snapshot (`recall`) |
| `runJob` | `{ id }` | run one bounded pass of a seeded job through the real JOBS engine |
| `dispatchResearcher` | `{ id }` | dispatch a seeded researcher (web research replays a cassette — see below) |

(`runJob`/`dispatchResearcher` need the job/researcher seeded via `seed.kind: files`. `setConfig`
is intentionally out of scope for the capability library.)

### The deterministic check menu (`expect.deterministic:`)

The named checks in `runner/validators.ts` (the `VALIDATORS` registry). An **unknown check name
fails loud** — a typo can never read as a pass.

| check | args | asserts |
| --- | --- | --- |
| `entitiesInclude` | `[names]` | every named thing became an entity node (DECOMP-17 recall) |
| `entitiesExclude` | `[names]` | none of the named descriptors/roles leaked as a node (precision) |
| `claimCitations` | `{ required? }` | every claim carries a source citation (DATA-10 / VAULT-13) |
| `wikilinkRendered` | `{ from, to }` | a `relatesTo` hint became a real `[[link]]` (CONNECT-12) |
| `recallCites` | `{ min }` | recall grounded its answer in ≥ `min` citations (ASK-7) |
| `recallContains` | `{ text }` | the recall answer contains a required substring |
| `countBounds` | `{ dir, min?, max? }` | file-count bound on `entities`/`claims`/`sources` (over/under-extraction) |
| `fileExists` | `{ path }` | a vault file exists (suffix-matched) — job/research artifacts |
| `fileContains` | `{ path, text }` | a vault file contains text — artifact content |
| `sourcesContain` | `{ text }` | ≥1 source body contains text — a finding carrying its fact/origin (RESEARCH-6) |
| `auditEvents` | `{ eventType, min }` | ≥ `min` audit events of a type fired |
| `spanOutcome` | `{ outcome, stage?, min }` | ≥ `min` operational spans ended with `outcome` (`ok`/`setaside`/`error`) — robustness: a corrupted item set aside *gracefully* (`setaside`) while good items still complete (`ok`) |
| `telemetryError` | `{ contains?, min? }` | ≥ `min` (default 1) dev-log `error` entries (optionally `contains` a substring) — robustness: a failure was *surfaced in telemetry* with a message, never swallowed silently |

**Need a new check?** Add one function to the `VALIDATORS` registry in `runner/validators.ts` (+ a
unit test in `runner/validators.test.ts`); it's then available to every scenario.

### The agent-judge (`expect.judge:`)

A **pinned evaluator model, distinct from the system-under-test** — a hard guard refuses any run
where the resolved judge == the resolved SUT (it can't grade its own homework). Each rubric scores
`[0,1]` × `runs` times; **passes iff the mean ≥ `threshold`** (default 0.8). The judge model is
`DEFAULT_JUDGE_MODEL`, overridable via `KB_EVAL_JUDGE_MODEL`. Judge prompt + every rationale are
logged for auditability.

### Research / external scenarios (the egress cassette — EVAL-6)

A research scenario's external fetches are **recorded once and replayed** (VCR-style) so scoring is
reproducible and never hits the uncontrolled live web. See `research.yaml` + `cassettes/README.md`.
To author one:

1. Seed the researcher in `fixtures/<ref>/.kb/researchers/registry.json`, and **pin its fetch to one
   allowlisted URL** (a free web-search picks varying URLs → cassette miss).
2. Add `meta: { cassette: <name>.json }` to the scenario.
3. Record the cassette once: `KB_EVAL=1 KB_EVAL_RECORD=1 npm run eval` (record wraps the real
   `makeGatedFetch`, so the SSRF/allowlist gate runs on capture; replay errors on a miss).

> ⚠️ **Committed cassettes are PUBLIC-WEB egress ONLY**, secret-scrubbed, fail-loud. **Never** record
> an M365 / internal-tenant / private-data fetch into a committed cassette — the guard
> (`assertCassetteClean`) refuses to write *or* replay a non-public-web or unscrubbed cassette. Private
> tiers use hand-authored synthetic fixtures, never recorded real data.

### Variants & baselines

A `variants:` list runs the scenario × the cross-product of config overrides
(`{model, promptVersion, toolConfig, budget}`) and scores **per variant** — the "tweak-and-compare"
loop (e.g. prompt v2 vs v3 across all scenarios). Each run emits a structured scorecard diffed against
the stored **baseline** (last-known-good) to surface regression/improvement deltas, plus a
reproducibility manifest (model versions, prompt versions, seed hash, image/CLI versions). Results are
gitignored, never promoted.

---

## When it runs

Two distinct triggers — keep them separate:

- **Every PR (CI `unit` job) — automatic, deterministic, no model.** The harness's own mechanism
  unit tests (`eval/runner/**/*.test.ts`: loader, validators, cassette guard, judge≠SUT guard,
  scorecard, baseline, variants) are in the main vitest `include`, so they gate every PR. This proves
  the harness *works*; it does **not** run real cognition.
- **On demand — opt-in, real cognition, scored.** The scenario suites (`eval/**/*.eval.ts`) run only
  via the eval config and **self-skip unless `KB_EVAL=1`** (live BYOA `copilot` + network, slow,
  non-deterministic). CI never runs these. This is where quality is actually measured:

```sh
cd app
KB_EVAL=1 npm run eval                    # the full scenario library (library.eval.ts), real copilot, scored
KB_EVAL=1 KB_EVAL_RECORD=1 npm run eval   # re-record research cassettes (--live)
```

The intended loop: tweak a prompt / tool / model → `KB_EVAL=1 npm run eval` → read the scorecard
(deterministic pass/fail + judge-score distribution per scenario × variant) diffed vs baseline →
tell improvement from regression before shipping.

The harness never touches the Principal's real vault or credentials — eval KBs are ephemeral, with
scoped eval creds only (EVAL-11).

---

## File map

- `scenarios/*.yaml` — the scenario library (one per capability; EVAL-10). Each has a header comment
  documenting what it tests + the requirement it traces.
- `fixtures/<ref>/` — seed material for `seed.kind: files` (entities, `.kb/` registries, sources).
- `cassettes/` — recorded public-web egress fixtures + the guardrail README (EVAL-6).
- `library.eval.ts` — the opt-in runner that drives **every** `scenarios/*.yaml` end-to-end (real
  copilot), logs the snapshot for human eyeball, and scores it. **Supersedes** the old enrich-only
  dogfood (the retired `enrichE2eDogfood.eval.ts` — consolidated here, one harness, per #241).
- `runner/` — the engine: `loader.ts` (schema) · `actions.ts` (verb → real pipeline) · `snapshot.ts`
  · `validators.ts` (deterministic check library) · `judge.ts` (agent-judge + judge≠SUT guard) ·
  `variants.ts` · `baseline.ts` · `manifest.ts` · `scorecard.ts` · `runScenario.ts` / `runMatrix.ts`,
  each with `*.test.ts` mechanism unit tests (the CI gate).
- `Dockerfile` — the clean-world image (pinned deps + BYOA `copilot` CLI + git) for reproducible,
  parallel-safe runs (EVAL-5).
- `runner/DESIGN.md`, `DESIGN-slice2.md`, `DESIGN-slice3.md` — the per-slice design + fork decisions.

### Legacy enrich-quality eval (still present)

`enrichQuality.eval.ts` + `granularityFixtures.ts` are the original opt-in **DECOMP-17 granularity**
eval (node-vs-attribute), run via `npm run eval:enrich`. It predates the general harness and remains as
a focused granularity check; new quality cases should be **scenarios** (`scenarios/*.yaml`) under the
general framework above.

### Dedup / node-finding precision-recall eval (EVAL-13)

`dedupQuality.eval.ts` + `dedupFixtures.ts` measure **entity dedup + node-finding** quality — "does
dedup actually work?" — over generalized, **synthetic / no-secrets** labeled fixtures. It drives the
REAL Connect matcher (within-block: collapse duplicate candidates / fold into the right existing node)
and the REAL Reflect consolidation (cross-block: merge name-variant nodes like *Caroline* / *Caroline
Winters Azzone* that exact-name blocking can't), and scores each against ground truth with the pure
metric `src/kb/dedupEval.ts` (pairwise precision/recall). HARD per fixture: **zero false merges of
distinct entities** (the don't-false-merge guard); SOFT: median recall clears a floor. Opt-in:

```sh
KB_EVAL=1 npm run eval -- dedupQuality      # real copilot; reports precision/recall + the guard
```

The metric + the verdict→groups reducers are unit-tested deterministically (`src/kb/dedupEval.test.ts`,
CI-green); only the live-copilot behavioural run is opt-in. Fixtures are shared with the Reflect impl.
