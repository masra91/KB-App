---
spec: SPEC-0042
key: EVAL
title: Evals & Scenario Harness (seeded-KB cognition evaluation)
type: architecture
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-07
related: [SPEC-0008, SPEC-0011, SPEC-0012, SPEC-0014, SPEC-0023, SPEC-0026, SPEC-0028, SPEC-0029]
supersedes: null
---

# Evals & Scenario Harness (seeded-KB cognition evaluation)

> A reproducible way to **evaluate the KB's cognition** — prompts, tool calls, models — across many
> seeded scenarios. You give a **seed case** (a starting KB + a script of actions: ingest this, ask
> that, run this job, dispatch this researcher) and **validators** (deterministic *and/or*
> agent-judged). The harness runs it against the **real** cognition in an **isolated clean-world
> container**, scores the result, and compares variants — so when you tweak a prompt/tool/model you
> get scored, comparable evidence of whether it improved or regressed. *Unit tests guard the
> mechanism; EVAL guards the **quality**.*

## 1. Intent (the why / JTBD)

The KB's value rests on **non-deterministic LLM cognition** (Decompose, Connect, Claims, Recall,
Researchers, Reflect). Unit/e2e tests (SPEC-0012) prove the *mechanism* deterministically but
**cannot measure quality** — "is this findings-note substantive?", "did Decompose pick the right
granularity?", "did Recall answer correctly and ground it?". Today `eval/` does this for one flow
(enrich-quality) with hand-wired harness code + human eyeballing. JTBD: *"as I tweak a prompt, a
tool definition, or swap a model, let me run a battery of disparate seeded scenarios and get a
scorecard — deterministic where I can assert exactly, agent-judged where quality is fuzzy — so I
can tell improvement from regression before shipping."* This spec generalizes `eval/` into a
**declarative, containerized, full-breadth scenario framework**.

## 2. The model

- **Scenario** (declarative data — YAML/JSON): `seed` + `actions` + `expect` + `variants` + `meta`.
- **Runner**: provisions an isolated clean-world KB → applies the seed → drives the action script
  **through the real pipeline/cognition** → snapshots the resulting state → runs validators → emits a
  scored result. It **never mocks the model-under-test** (that's the whole point).
- **Validators**: **deterministic** (exact assertions over vault state / audit / spans) and
  **agent-judge** (a pinned evaluator model scores an output against a rubric). Composable per scenario.
- **Variant matrix**: a scenario × a set of config variants `{model, promptVersion, toolConfig, budget}`
  → cross-product → per-variant scorecard + diff.
- **Container**: each run executes in a Dockerized clean world (pinned deps + BYOA CLI + git), with
  **controlled egress**, so results are reproducible and parallel-safe.

### Scenario schema (illustrative)

```yaml
id: enrich-granularity-hopper
capability: decompose            # ingest|decompose|connect|claims|recall|research|reflect|jobs
seed:
  kind: empty | files | snapshot
  ref: fixtures/hopper-bio/      # vault files or a restorable KB snapshot
actions:                         # the KB's REAL verbs, in order
  - ingest:  { text: "Grace Hopper, a computer scientist, worked on the COBOL language…" }
  - awaitDrain: { stages: [decompose, connect, claims] }
  - ask:     { query: "What did Grace Hopper work on?" }
expect:
  deterministic:                 # named checks from the validator library (exact)
    - entitiesInclude: ["person/grace-hopper"]
    - entitiesExclude: ["concept/first-computer-programmer"]
    - claimCitations:  required
    - recallCites:     { min: 1 }
  judge:                         # agent-judged (pinned model, N runs vs threshold)
    - rubric: "Is the recall answer correct, grounded in the KB, and cited?"
      runs: 3
      threshold: 0.8
variants:                        # optional matrix; omitted = the default config
  - { promptVersion: decompose/v2 }
  - { promptVersion: decompose/v3 }
```

## 3. Requirements

| ID       | Priority | Statement (short) | Verify | Traces |
| -------- | -------- | ----------------- | ------ | ------ |
| EVAL-1   | must     | A **scenario is declarative data** (YAML/JSON), schema-validated: `seed` (empty/files/snapshot) + ordered `actions` using the KB's **real verbs** (`ingest`/`ask`/`runJob`/`dispatchResearcher`/`setConfig`/`awaitDrain`) + `expect` + optional `variants` + `meta` (capability tag). A malformed scenario fails fast with a clear error, never a partial run | none-yet | TEST; LANG |
| EVAL-2   | must     | The runner exercises the **REAL cognition** (prompts/tools/model) end-to-end and **never mocks the model-under-test** — it measures actual model work. The *non-model* harness (seed, ids, time) is controlled/seeded for reproducibility (ULID/`Date.now` injection — SPEC-0011), so the model output is the single measured variable | none-yet | ORCH; ENG-5 |
| EVAL-3   | must     | **Deterministic validators**: a named, parameterized check library asserting exactly over the resulting **vault state + audit + spans** — entities include/exclude, claim shape, citations present, wikilinks rendered (`relatesTo`→`[[link]]`), count bounds, recall contains/cites, audit events, span assertions. Exact pass/fail | none-yet | DATA; AUDIT; CONNECT-12; ASK-7 |
| EVAL-4   | must     | **Agent-judge validators**: a **pinned evaluator model** — distinct from the system-under-test (a hard guard refuses a run where the resolved judge == the resolved SUT model — it can't grade its own homework), version-recorded — scores an output against a rubric → a `[0,1]` score + rationale; run **N times** and aggregate as the **mean score vs the `threshold`** (pass iff `mean ≥ threshold`, default 0.8). The judge prompt + every rationale are logged for auditability | none-yet | AUTO; PRIN-2 |
| EVAL-5   | must     | Each scenario runs in an **isolated, Dockerized clean-world container** (pinned deps + BYOA `copilot` CLI + git): a **fresh KB per run**, no host/global-state bleed, parallel-safe, reproducible. The image **pins everything** (deps, CLI version, env) so a result is re-runnable | none-yet | STACK; ENG (E1) |
| EVAL-6   | must     | **Controlled egress** inside the container — researcher / external scenarios run against a **recorded-and-replayed** (VCR-style) or **allowlisted** network, never the uncontrolled live world, so external-cognition evals (RESEARCH) are **reproducible** and bounded. Recorded fixtures carry **no secrets/PII** | none-yet | RESEARCH-8,9; AUTO-6 |
| EVAL-7   | must     | **Variant matrix**: the harness runs a scenario × a set of config variants `{model, promptVersion, toolConfig, budget}` as a cross-product and scores **per variant** — the headline "tweak-and-compare" loop (e.g. prompt v2 vs v3 across all scenarios) | none-yet | ORCH-16 |
| EVAL-8   | must     | **Scorecard + baselines**: a run emits a structured scorecard (scenario × variant → deterministic pass/fail + judge-score distribution), diffed against a stored **baseline** (last-known-good) to surface **regression/improvement deltas**. Results stored structured + gitignored (never promoted); a human-readable summary is produced | none-yet | OBS |
| EVAL-9   | must     | **Reproducibility manifest** per run: model version(s), prompt versions, tool configs, seed hash, image + CLI versions, and the RNG/time seeds — so any result is attributable and re-runnable. A result without its manifest is invalid | none-yet | DATA-5; ENG |
| EVAL-10  | must     | **Full-breadth scenario library (v1 done-bar)**: at least one meaningful scenario for **each** capability — ingest, decompose, connect, claims, recall, research, jobs, reflect — proving the framework end-to-end across the system, not just enrich | none-yet | LIFE; INGEST; DECOMP; CLAIMS; CONNECT; ASK; RESEARCH; REFLECT; JOBS |
| EVAL-11  | must     | **Opt-in, not a default CI gate** (live model + non-deterministic + slow) — like today's `KB_EVAL=1`. A small **deterministic-only smoke subset** MAY gate CI. The harness **never touches the Principal's real vault or credentials** and **never pollutes a real KB** — eval KBs are ephemeral + scoped eval creds only | none-yet | TEST-9; PRIN-1; AUTO-11 |
| EVAL-12  | should   | Scenarios + the validator library are **authorable by non-engineers** (data + named checks); custom deterministic checks register into the library. Adding a case = writing a YAML scenario + (optionally) a rubric, no harness code | none-yet | PRIN |
| EVAL-13  | must     | **First agent-stage QUALITY evals: node-finding + entity dedup** (the Principal's chosen starting point for eval-driven stage improvement). A scenario family seeds a KB with **known near-duplicate entities** — name-variant pairs where a short name is the same real entity as its fuller form (e.g. a "Caroline" node and a "Caroline Winters Azzone" node; **generalized fixtures, NOT hardcoded to that pair**) — plus **known missing links** and **known redundant links**. It measures the dedup/Reflect+Connect cognition's **precision & recall**: does it propose a merge for the true duplicates (and **not** merge genuine distinct same-name entities — the REVIEW-18 "Leavenworth/Paris" false-merge guard), does missing-link discovery find the planted real links, does redundant-link pruning catch the duplicates. Deterministic validators (EVAL-3: expected merge proposal / link present-or-absent / Review raised) + agent-judge (EVAL-4) for borderline calls; scored across the **variant matrix** (EVAL-7: prompt/model versions) so we can **tune the agents against a measured baseline** (EVAL-8). This is how Reflect's dedup mode (REFLECT-16) and Connect's blocking get measurably better, not vibes. | none-yet | EVAL-3,4,7,8,10; REFLECT-16; REVIEW-18; CONNECT-15 |

## 4. Architecture sketch

- **Image** (`eval/Dockerfile`): node + pinned app deps + BYOA `copilot` CLI + git; the runner entrypoint.
- **Runner** (`eval/runner/`): scenario loader+schema → KB provisioner (seed) → **action driver** (maps
  each verb to the real pipeline/IPC: `ingest`→capture path, `ask`→recall, `runJob`→scheduler,
  `dispatchResearcher`→dispatcher) → state snapshotter (entities/claims/sources/recall/audit/spans) →
  validator engine (deterministic library + agent-judge) → scorer → result writer.
- **Egress proxy**: a record/replay (cassette) layer the container routes external traffic through;
  record once (real), replay deterministically (RESEARCH evals), or allowlist for live.
- **Reporting** (`eval/report/`): scorecard JSON + baseline diff + a human summary.
- **Builds on `eval/`**: today's `granularityFixtures` / `enrichE2eDogfood` become **scenarios**; their
  hand-wired drive/assert logic moves into the runner + deterministic-check library.

## 5. Open questions (forks)

1. **Action driver fidelity** — drive the **pipeline modules in-process inside the container** (fast,
   white-box; what `eval/` does) vs the **packaged app over IPC** (black-box, full-fidelity). Lean:
   in-process modules in v1 (the cognition is identical; far simpler harness), packaged-app parity as a
   follow-up if a surface-level eval needs it.
2. **Judge model pinning** — which model is the canonical judge, and is the judge itself periodically
   meta-evaluated (judge drift)? Pin one; record its version (EVAL-9); revisit calibration later.
3. **Egress: record/replay vs live-allowlist default** — cassettes give determinism but go stale as the
   web changes; live-allowlist is honest but non-deterministic. Lean: **record/replay default** for
   reproducible scoring, with a `--live` opt-in to refresh cassettes.
4. **Eval credentials** — scoped BYOA creds for the container (no Principal secrets); how provisioned in
   CI vs local. (AUTO-11 "no stored secrets" holds — injected at runtime, never baked into the image.)

## 6. Slices (build order toward the full-breadth v1)

- **Slice 1 — harness core:** the container image + scenario schema/loader + action driver + the
  **deterministic** validator library + scorecard; one real scenario (enrich) end-to-end. Resolves fork #1.
- **Slice 2 — judge + matrix:** the **agent-judge** validator + the **variant matrix** + baseline diffing.
  Resolves fork #2.
- **Slice 3 — egress + breadth:** the egress **record/replay** layer + the **full scenario library**
  across all capabilities (EVAL-10) + the deterministic CI smoke subset. Resolves fork #3/#4.
- Done = all three (the Principal's container-first, data-driven, full-breadth vision).

## 7. Changelog

- 2026-06-08 — **EVAL-13: first agent-stage quality evals — node-finding + entity dedup (Principal).** The Principal chose dedup/node-finding as the first eval-driven stage-improvement target ("a good case for our first evals… finding nodes and dedupe"), seeded by the live "caroline" vs "caroline winters azzone" duplicate (generalized, not hardcoded). Measures merge/missing-link/redundant-link **precision & recall** — including the **don't-false-merge-distinct-same-names** guard (REVIEW-18 Leavenworth/Paris) — across the variant matrix so Reflect's dedup mode (REFLECT-16) + Connect's blocking get tuned against a measured baseline, not vibes. Held for next-session impl per wind-down.
- 2026-06-07 — **Slice-2 ratification pinned into EVAL-4** (KB-Lead): the judge aggregation is the **mean
  score vs the threshold** (`mean ≥ threshold`, default 0.8) — *not* a per-run "pass-rate" (which would need
  an unspecified per-run cutoff); and the judge≠SUT property is a **hard guard** (refuse a run where the
  resolved judge model == the resolved SUT model), not just an audited note. Aligns the spec with
  Slice-2's design + impl (#242).
- 2026-06-06 — **Spec created** (Principal — wants a seeded-KB evals platform to evaluate model/prompt/tool
  work across disparate scenarios; deterministic *and* agent-judged validation). Principal chose
  **container-first** (clean-world Docker runner), **declarative YAML/JSON scenarios**, and **full-breadth
  v1** (a scenario per capability). Generalizes the existing `eval/` (enrich-quality dogfood). Drafted for
  review — NOT self-merging.
