# SPEC-0042 EVAL — Slice 2 (agent-judge + variant matrix + baseline diff) — design draft + fork recs

> **Status: DRAFT for KB-Lead ratification (forks) — NOT code-locked.** Same model as Slice-1: design +
> recommend-with-rationale on the forks, ping PM → KB-Lead ratifies → deep build. Builds on the Slice-1
> harness (`runScenario`/ActionDriver/validators/scorecard). Record/replay egress STORE stays Slice-3.
> PR → KB-Lead (product+forks) + KB-QD (gate-2).

## Slice-2 scope (SPEC-0042 §6)

The **agent-judge** validator (EVAL-4) · the **variant matrix** (EVAL-7) · **baseline diff** (EVAL-8).
Resolves fork #2 (judge-model pinning).

## Module layout (extends `eval/runner/`)

- `judge.ts` — the **agent-judge validator** (EVAL-4): a pinned evaluator model scores an output against a
  rubric → score + rationale; run **N times**, aggregate the distribution vs a `threshold`. Logs the judge
  prompt + each rationale (auditability). Separate Copilot session from the system-under-test.
- `variants.ts` — resolve a `ScenarioVariant` → apply its config around a `runScenario` call (the matrix
  cross-product) → a per-variant scorecard column.
- `baseline.ts` — load/store a baseline scorecard (gitignored) + diff current-vs-baseline → regression/
  improvement deltas (deterministic pass/fail flips + judge-score shifts).
- extends `scorecard.ts` — add the judge-score distribution + variant column + baseline-diff to the shape;
  `runMatrix.ts` — scenario × variants → combined scorecard + baseline diff + human summary.
- The Slice-1 `JudgeCheck` / `ScenarioVariant` types in `scenario.ts` are already forward-stable — Slice-2
  implements them.

## Fork recommendations (KB-Lead ratifies)

**Fork #2 — judge-model pinning (deferred from Slice-1) → RECOMMEND: pin ONE judge model, distinct from
the system-under-test, version-recorded; defer judge-drift meta-eval.** The judge runs via the Copilot SDK
in its **own session** with a pinned model selected by a dedicated `KB_EVAL_JUDGE_MODEL` (default a strong
current model, NOT whatever the SUT uses — so the judge can't "grade its own homework" with the same
weights). The exact model id + version is captured in the **reproducibility manifest (EVAL-9)** so a
score is attributable. **Judge meta-evaluation / drift calibration is deferred** (SPEC §5 fork #2 "revisit
calibration later") — recorded versioning is the v1 guard; a periodic judge-vs-golden calibration is a
later item. KB-Lead/Principal to name the default judge model id (I'll pin whatever they choose).

**Fork S2-A — variant injection mechanism → RECOMMEND: env/config injection around each run; ship the
`model` + `budget` axes in Slice-2, defer `promptVersion`/`toolConfig` to a thin prompt-registry follow-up.**
Today the model is read from `process.env.KB_COPILOT_MODEL` by every decider + recall, and recall/researcher
budgets are per-call/config — so the **`model` and `budget` variant axes work now** (set the env/budget
around each `runScenario`, restore after; the matrix is the scenario × variants cross-product). **`promptVersion`
is a fixed const today** (`DECOMPOSE_PROMPT_VERSION = 'decompose/v2'`) — there's no prompt-version registry,
so a real `promptVersion` axis needs that registry first. Recommend: Slice-2 lands `model` + `budget` (the
headline tweak-and-compare loop), and `promptVersion`/`toolConfig` axes land when a prompt-version registry
exists (small follow-up) — flagging so KB-Lead rules whether to pull the registry into Slice-2 or defer.

**Fork S2-B — baseline storage + diff → RECOMMEND: gitignored JSON baselines + per-check delta diff,
`--update-baseline` to refresh.** Store the last-known-good scorecard as JSON under `eval/baselines/`
(**gitignored, never promoted** — EVAL-8); the diff surfaces deterministic pass/fail **flips** (regress/
improve) + judge-score **distribution shifts** vs the baseline; an explicit `--update-baseline` flag
refreshes it (so a baseline is never silently overwritten by a worse run). A run without its manifest
(EVAL-9) is invalid.

**Fork S2-C — judge run-count + threshold → RECOMMEND: N=3 default, aggregate pass-rate vs scenario
`threshold` (default 0.8), per-run rationale logged.** The judge is itself non-deterministic, so a single
call isn't trustworthy: run N (scenario-overridable, default 3), aggregate (pass-rate or mean score) against
the scenario's `threshold` (default 0.8 per the SPEC example), and **log every judge prompt + rationale**
(EVAL-4 auditability). Mirrors the deterministic-validators' "report + score", not a hard single-shot.

## What's drafted now vs after ratification

- **Now (this draft):** the design + fork recs; the `JudgeCheck`/`ScenarioVariant` types already exist
  (Slice-1, forward-stable); I can land the **fork-independent** judge-result + baseline-diff scorecard
  shapes as a thin skeleton.
- **After KB-Lead ratifies (deep):** `judge.ts` (pinned-model session + N-runs/threshold), `variants.ts`
  (model+budget injection + matrix), `baseline.ts` (store+diff), `runMatrix.ts`, the reproducibility
  manifest (EVAL-9), tests (judge aggregation pure logic, variant resolution, baseline diff; an opt-in
  judged scenario e2e), full validate → PR.
