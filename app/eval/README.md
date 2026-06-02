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

## Output-quality dogfood (end-to-end) — `enrichE2eDogfood.eval.ts`

A full **live** `capture→archive→decompose→connect→claims(→recall)` pass that judges the
*user-facing output* (not plumbing), complementing the deterministic granularity eval above. It
**logs** the actual entities + claims + link blocks + recall answer so a human judges quality; the
assertions are gross-failure floors only (it's LLM-judged + non-deterministic).

```sh
cd app
KB_EVAL=1 npx vitest run --config eval/vitest.config.ts eval/enrichE2eDogfood.eval.ts
# one case at a time (each is a slow live run):
KB_EVAL=1 npx vitest run --config eval/vitest.config.ts eval/enrichE2eDogfood.eval.ts -t "recall"
```

Cases + what to eyeball in the log:
- **e2e quality** — entity granularity (DECOMP-17: people/orgs are nodes, descriptors are claims),
  wikilinks (CONNECT-12: `relatesTo` → `[[links]]`), per-claim `Source:` citation (VAULT-13).
- **CLAIMS-19 dedup** — a single source whose relational fact is restated per-entity; the log prints
  any exact within-source restatement dupes remaining (the LLM usually phrases each subject
  distinctly, so this mostly observes the *relational-residual* pattern — distinct-subject claims
  the dedup intentionally keeps).
- **recall** — a grounded, cited answer over the built KB (`grounded:true` + citations resolve).

Findings of record (first run, 2026-06-02): granularity/wikilinks/citations/recall all **good**;
one real gap — **multi-source claims** (a Connect-merged entity gets claims from `derivedFrom[0]`
only → other sources' facts dropped), filed as an issue + mapped to SPEC-0016 §7. `resolveCopilotCliPath()`
supplies the recall SDK's `cliPath` so it works on a stripped PATH (#160/#165).

## Files

- `granularityFixtures.ts` — the golden set (reviewed by KB-QD; add precision-trap cases here).
- `enrichQuality.eval.ts` — the opt-in granularity runner (real decider × N runs → `enrichEval` scoring).
- `enrichE2eDogfood.eval.ts` — the opt-in end-to-end output-quality dogfood (above).
- `vitest.config.ts` — opts these files in (the main config excludes them).
- Scoring logic + its unit tests live in `src/kb/enrichEval.ts` / `enrichEval.test.ts`.

## Follow-up

Granularity (**DECOMP-17**) + the e2e dogfood now cover the headline axes. **CLAIMS-19** within-source
dedup is hard to stress behaviorally (the LLM rarely emits verbatim within-source dupes) — its
deterministic unit (`claimDedup.test.ts`) + Connect-drain integration test remain the real gate. The
**multi-source-claims** gap (SPEC-0016 §7 "Entity-driven unit after Connect") is the open correctness
item the dogfood surfaced; its fix is gated on the Principal's per-(entity×source) decision.
