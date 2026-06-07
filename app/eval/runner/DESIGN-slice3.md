# SPEC-0042 EVAL — Slice 3 (egress record/replay store + full-breadth scenario library) — design + fork recs

> **Status: DRAFT for KB-Lead ratification (forks) — NOT code-locked.** Final slice. Same model as
> Slice-1/2: design + recommend-with-rationale on the forks → ping PM → KB-Lead ratifies → deep build.
> Builds on Slice-1/2 (runScenario/ActionDriver/validators/judge/matrix/baseline). Resolves fork #3
> (egress record/replay STORE — the seam was ratified in Slice-1; the store lands here) + EVAL-6/10/11.
> PR → KB-Lead (product+forks) + KB-QD (gate-2).

## Slice-3 scope (SPEC-0042 §6)

The egress **record/replay (cassette) store** (EVAL-6) so RESEARCH/external scenarios are reproducible +
secret-free; the **full-breadth scenario library** — ≥1 scenario per capability (ingest · decompose ·
connect · claims · recall · research · reflect · jobs), EVAL-10; and the **deterministic CI smoke subset**
(EVAL-11) — the part that MAY gate CI.

## Module layout (extends `eval/runner/` + `eval/scenarios/` + `eval/cassettes/`)

- `cassette.ts` — the record/replay store: a cassette is recorded request→response fixtures keyed by a
  stable request key; `record` mode does a real egress + writes (scrubbed); `replay` mode serves from the
  cassette, erroring on a cache miss (so a replay can't silently hit the live web).
- `egress.ts` — wraps the research adapters' fetch/session at the existing seam (makeGatedFetch /
  WebResearchOptions.session) with the cassette, so `dispatchResearcher` actions run reproducibly. Wires
  the `dispatchResearcher` driver verb (today a clear per-slice throw) onto runInlineResearch/runResearcherNow.
- `eval/scenarios/*.yaml` — one scenario per capability (8 total), each with deterministic checks (+ judge
  rubrics where quality is fuzzy); research scenarios reference a cassette.
- `eval/cassettes/<scenario>/…json` — the recorded fixtures (see fork S3-B on committed-vs-gitignored).
- the deterministic CI smoke subset (EVAL-11) — a no-model / replay-only fast path that MAY gate CI.

## Fork recommendations (KB-Lead ratifies)

**Fork S3-A — egress interception point → RECOMMEND: the app's egress SEAM (gated-fetch / ResearchFn
session), not a network-level proxy.** The researchers already expose injectable seams — `makeGatedFetch`
(`(url) → GatedFetchResponse`) and `WebResearchOptions.session` / Code/M365 equivalents. The cassette
wraps the fetch at that seam: record real `GatedFetchResponse`s keyed by the (request-only, D6a) URL,
replay by key. Rationale: it's clean + deterministic, keeps the egress GATE (SSRF/allowlist) in force,
captures exactly the request-only egress (no incidental traffic), and is trivially secret-free (we control
the recorded shape). A network-level VCR/proxy is heavier, harder to keep secret-free, and would record
incidental SDK traffic. *Small enabling change:* add an injectable `fetch?` to the research adapter options
(defaulting to `makeGatedFetch`) so the harness can inject the cassette fetch.

**Fork S3-B — cassette format + storage → RECOMMEND: COMMITTED JSON cassettes, secret-scrubbed on record,
`--live` to refresh.** EVAL-6 requires reproducible replay carrying no secrets/PII. Cassettes must be
**committed** (gitignored cassettes wouldn't reproduce in CI / on another machine — defeating replay), as
JSON `{ key, request(url-only), response(status,text,truncated) }`, with a **scrub step on record** that
drops auth headers/tokens/PII and asserts the request is request-only (D6a). `--live` re-records. (Contrast
the gitignored *baselines* of Slice-2 — those are run outputs; cassettes are reproducibility inputs, so
they're committed.) Flagging for the dep/secret guard: a recorded fixture is reviewed like code.

**Fork S3-C — scenario library + CI smoke subset → RECOMMEND: one scenario per capability (8); the
deterministic-replay subset is the CI smoke gate, live-model scenarios stay opt-in.** EVAL-10 = ≥1
scenario each for ingest/decompose/connect/claims/recall/research/reflect/jobs. EVAL-11: a small
**deterministic** subset MAY gate CI — recommend the CI smoke = the pure runner/validator unit tests
(already in CI) + any **replay-only, no-live-model** scenario assertions that are deterministic; the full
library (real copilot) stays opt-in (`KB_EVAL`), never a default CI gate (live + slow + non-deterministic).
Which of the 8 are deterministic-smoke-able vs opt-in-only is a per-scenario call I'll enumerate in the
build; research scenarios run under replay (cassette) so they're reproducible but still opt-in for the live
model unless a pure-replay assertion exists.

## What's drafted now vs after ratification

- **Now (this draft):** the design + fork recs.
- **After KB-Lead ratifies (deep):** `cassette.ts` (record/replay + scrub) + `egress.ts` (seam wrap +
  `dispatchResearcher` wiring) + the 8 capability scenarios + committed cassettes for the research one +
  the CI smoke subset + tests (cassette record/replay + scrub pure logic; per-scenario), full validate → PR.
