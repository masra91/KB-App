# Enrich-quality eval (opt-in)

The **behavioral** check for the enrich-quality work (#34) — specifically **DECOMP-17** (Decompose
node-vs-attribute granularity). Granularity is LLM-judged, so the deterministic CI tests prove the
*mechanism* but not the *behavior*; this eval runs the real `decompose/v2` prompt over a curated
golden set and asserts the behavior directly.

## Why it's opt-in (not CI)

It needs a real **BYOA `copilot` + network** and is **non-deterministic**, so — like the packaged
Playwright e2e — it runs **on demand**, not in the `quick` gate. It's double-gated: it lives under
`eval/` (the unit config's `include` is `src/**`, so the normal suite never collects it) **and** it
skips unless `KB_EVAL=1`.

The CI gate stays the deterministic tests: `decomposeAgent.test.ts` (the prompt *policy* +
version), `claimDedup.test.ts` (the dedup core), and `enrichEval.test.ts` (this eval's pure scoring
logic).

## Run it

```sh
cd app
KB_EVAL=1 npm run eval:enrich          # default 3 runs per fixture
KB_EVAL=1 KB_EVAL_RUNS=5 npm run eval:enrich
```

## The pass-bar (KB-QD)

Per curated fixture (`granularityFixtures.ts`):

- **(a) must-be-node set** — the genuine entities ARE extracted (recall). **HARD**, must hold in
  *every* run.
- **(b) must-NOT-be-node set** — roles / descriptors / relationships do **not** become nodes
  (precision; the dogfood `concept/first-computer-programmer`-type cases). **HARD**, every run.
- **(c) total node count ≤ a loose upper bound** — the over-extraction regression guard. Reported
  (median + range, and how many runs exceeded the bound) but **not** itself hard-failed —
  ±tolerance applies only to raw totals.

The headline is the dogfood case: a 2-sentence bio that pre-DECOMP-17 yielded ~6 nodes (with "first
computer programmer" promoted to its own `concept` node) should now yield ≤3 nodes, with the
descriptor recorded as a *claim*, not a node.

## Files

- `granularityFixtures.ts` — the golden set (reviewed by KB-QD; add precision-trap cases here).
- `enrichQuality.eval.ts` — the opt-in runner (real decider × N runs → `enrichEval` scoring).
- `vitest.config.ts` — opts these files in (the main config excludes them).
- Scoring logic + its unit tests live in `src/kb/enrichEval.ts` / `enrichEval.test.ts`.

## Follow-up

This covers **DECOMP-17** granularity. A **CLAIMS-19** dedup eval (assert the LLM's restated-per-
entity claims collapse to the expected within-source count end-to-end) is a tracked follow-up;
CLAIMS-19 already has a deterministic unit + Connect-drain integration test, so its behavioral gap
is smaller than granularity's.
