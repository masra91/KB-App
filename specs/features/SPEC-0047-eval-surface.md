---
spec: SPEC-0047
key: EVALSURF
title: Eval Surface — per-stage, per-action, confidence & ambiguity evals (the quality instrument)
type: feature
status: draft
owners: [KB-Lead, KB-Developer-1, Principal]
created: 2026-06-13
related: [SPEC-0042, SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0020, SPEC-0024, SPEC-0026, SPEC-0028, SPEC-0046]
stage: Cross-cutting
supersedes: null
---

# Eval Surface — the quality instrument

> Turn evals from "a few capability smoke tests" (SPEC-0042) into a **comprehensive instrument**
> that measures, per pipeline stage, whether each decision is *correct*, whether confidence is
> *calibrated*, and whether genuine *ambiguity is surfaced to the Principal instead of guessed*.
> Built first-principles from the **error types at each stage**, using the **metrics the field has
> settled on**. This is how we answer "is opus-4.8 right?", "did that prompt change regress
> linking?", and "is the machine quietly corrupting the graph?" with data, not vibes.

## 1. Intent (the why / JTBD)

A second brain's value collapses silently: a wrong **merge** fuses two people into one node, a
missed **link** orphans a fact, an over-confident **claim** asserts a hypothesis as fact, a
**recall** answer cites a source that doesn't support it. None of these throw; they degrade trust.
JTBD: *"let me change a model or a prompt and KNOW, before shipping, whether each stage got better
or worse — and trust that when the machine is unsure, it asks me rather than guesses."*

This extends SPEC-0042 (the harness exists: scenarios, validators, judge, cassettes, baseline,
manifest). SPEC-0042 proved the *plumbing*; this spec defines the *instrument* — what we measure,
on what corpora, with what metrics, at what cadence.

## 2. First principles

1. **Three-level diagnostic stack, scored in order for error localization** (cascades hide in
   end-to-end scores): **(a) end-to-end** (notes-in → correct KB state / correct recall) = the
   release headline; **(b) trajectory** (the hand-offs — a bad Connect merge that Compose then
   faithfully writes up looks "faithful" in isolation but the page is wrong) = catches cascades;
   **(c) component** (each stage on a *pinned* upstream input) = the CI/debugging signal. When
   end-to-end fails, attribute to the **first-divergent stage**.
2. **Isolate a stage by pinning its upstream to gold** — decompose: source→gold candidates;
   connect: gold candidates + frozen KB snapshot→gold link/merge/create; claims: gold entities→gold
   atomic claims; recall: frozen vault→gold answer + gold supporting passages.
3. **Measure the decision boundary, not just the happy path** — every stage's *errors* (§4) and
   every stage's choice to **act vs. ask** (§6) are first-class eval targets.
4. **The corpus is the asset.** Private/own-vault + post-cutoff content (the deciders may have
   memorized public entities); silver→gold promotion; never prompt-tune against the headline set.
5. **Re-eval on every model/prompt swap** — calibration, abstention, and ambiguity detection are
   the properties most silently broken by a model change (directly the eval-vs-prod model gap that
   bit us: prod ran gpt-5.5/Haiku while evals pinned opus).

## 3. The eval surface = three dimensions

Every eval case is positioned on:
- **Stage** — decompose · connect · claims · compose · reflect · recall · research.
- **Action type** (within a stage) — e.g. Connect: *link-to-existing · merge-dedup · create-new
  (NIL) · raise-review*; Claims: *extract · skip · raise-review*; Decompose: *entity vs attribute*.
- **Difficulty / epistemic class** — *clear* (unambiguous, high-confidence) vs *ambiguous*
  (homonym, overlapping names, fuzzy boundary, contradictory sources, missing context). Metrics are
  **bucketed by this** — a system can be great on clear cases and dangerous on ambiguous ones.

## 4. Error taxonomy per stage (what we are testing for)

Derived from the decider map (decision shapes + confidence + review triggers in the code):

| Stage | Decision(s) | Headline error types to catch |
|---|---|---|
| **Decompose** (`decomposeAgent.ts`) | entity vs attribute; extract vs skip; signal | over-extraction (role/descriptor becomes a node), under-extraction (real entity missed), wrong kind, granularity drift |
| **Connect** (`connectAgent.ts`) | cluster; link-to-existing; **merge** existing; create-new; raise-review | **false merge (cardinal sin)**, missed merge, wrong link target, wrong NIL/create-new, fails to raise-review on a genuine homonym |
| **Claims** (`claimsAgent.ts`) | extract; skip; epistemic status (fact/interp/hypothesis); raise-review | unsupported/hallucinated claim, mis-status (hypothesis asserted as fact), non-atomic/compound claim, dropped claim, wrong subject |
| **Compose** (`composeAgent.ts`) | grounded prose; weave links | ungrounded sentence (caught at parse today — eval the *faithfulness* + citation attributability), bad/empty fallback, wrong wikilink |
| **Reflect** (`reflectAgent.ts`) | additive (auto) vs destructive (review) vs low-conf (review) | destructive auto-applied (should've been review), false consolidation, missed emergent topic |
| **Recall** (`recallAgent.ts`) | navigate; ground; adapt depth; answer | hallucination/ungrounded answer, citation that doesn't support the sentence, wrong/over-long depth, false "no evidence" |
| **Research** (`researchWebAgent.ts`) | search; fetch; extract; attribute | shallow finding (depth floor), mis-attribution, egress/SSRF violation, fabricated fact |

Note from the map: confidence is `[0,1]` on decompose/connect/claims/reflect but **no code soft-floor
today** (prompt steer only); grounding is absolute (compose/recall). The eval surface is where
confidence and abstention finally get *measured*.

## 5. Metrics per concern (field-settled; opinionated)

- **Per-stage decisions:**
  - Entity linking → **GERBIL micro-F1 (strong/InKB) + NIL accuracy** (the create-new branch).
  - Dedup/merge → **CoNLL F1 = mean(MUC, B-cubed, CEAF) + pairwise P/R**. **Gate on B-cubed
    precision** + keep the existing **hard "don't-false-merge" guard**. *Avoid MUC-alone — it
    rewards over-merging, our worst failure.* (extends existing `dedupEval`.)
  - Claims → **FActScore-style claim precision** (verify against the **source note**, not the web)
    **+ DecompScore** (atomicity & coverage).
- **Calibration** → **ECE + reliability diagram**, per decision stage.
- **Abstention / surfacing** → **risk–coverage curve + AURC + precision@coverage**; ship a target
  operating point ("selective risk ≤ X% at coverage ≥ Y%"). Abstention + ambiguity-flagging share
  one risk–coverage frame — this is the literal product value.
- **Ambiguity detection** (first-class) → **flagging precision/recall (true-positive vs
  false-positive surfacing)** + **Disambig-F1** for interpretation quality. Set a *realistic* bar —
  ambiguity classification is near-chance for naive methods.
- **LLM-as-judge** (compose prose, recall answers) → **rubric pairwise win-rate, order-swapped,
  multi-judge**, judge model a **different family** than the SUT, validated by **judge-vs-human κ ≥
  0.6**. (Harness already enforces judge ≠ SUT.)
- **Grounding** (compose, recall) → **RAGAS faithfulness + context-precision + context-recall**;
  **per-citation AIS rate** (% attributable vs extrapolatory/contradictory/non-attributable).

## 6. Confidence & ambiguity are first-class (the product value)

The thing that makes a second brain trustworthy is **knowing when it doesn't know**. So:
- Surface each decider's confidence into vault metadata so evals can read it (today it's emitted
  then dropped).
- Build a labeled **ambiguous vs clear** corpus per stage (homonym / overlap / fuzzy-boundary /
  contradiction / missing-context).
- Score the **act-vs-ask decision** as binary classification on that corpus + on the shared
  risk–coverage frame. A regression here = the machine started guessing where it should ask.

## 7. Corpora & query sets

- **Per-stage golden set** (not one global): ≥100 curated, slice-balanced; grow over time.
- **Own-vault + post-cutoff** content for headline sets (anti-memorization); **synthetic** for
  edge-case stress (corrupted/legacy/malformed — folds in the ENG-15/16 partial-data class).
- **silver → gold** promotion with SME review + **inter-annotator κ** as a corpus-health gate.
- **Held-out/rotating slice** never seen during prompt dev (overfitting tripwire); leakage audit.

## 8. Harness extensions (extend SPEC-0042, do NOT duplicate)

From the framework gap analysis — all reuse the existing runner/validators/judge/baseline/cassette:
- **Stage-unit isolation**: new `seed.kind: 'entities' | 'candidates' | 'claims'` (pinned upstream)
  + `stage: 'unit' | 'integration'` on the scenario.
- **Case metadata**: `ambiguityType?` + `difficulty?` on scenarios; metrics bucketed by it.
- **Richer check results**: add `{margin?, soft?, confidence?}` to `CheckResult` (near-miss
  visibility), and new confidence/ambiguity validators (`ambiguitySurfaced`, `claimContradiction`,
  `entityOverlapDetected`, confidence-bucketed include/exclude).
- **New metric modules**: clustering (B-cubed/CEAF/CoNLL), EL (GERBIL-style), calibration (ECE),
  risk–coverage/AURC, RAGAS-faithfulness/AIS.
- **Scenario templating** (`base:` inheritance) so the ambiguous-vs-clear matrix isn't hand-copied.
- **Prompt-version registry** (the deferred S2-A fork) to unlock the `promptVersion` variant axis —
  required to A/B a prompt change.

## 9. Cadence (maps to the test stack)

- **Per-PR (CI)**: harness unit tests + cheap deterministic component evals on golden sets
  (no/low model) — fast regression signal.
- **Per-build**: full end-to-end + trajectory on the real-vault headline set.
- **Per-model/prompt swap**: re-run *everything*, especially calibration/abstention/ambiguity.
- **Every bug fix adds a regression eval case** (E2/ENG bar); malformed/legacy items become
  permanent fixtures.

## 10. Requirements (must, unless noted) — `Verify: none-yet → test:`

- **EVALSURF-1** Each stage has a **component eval** runnable on a pinned upstream gold input.
- **EVALSURF-2** Connect dedup is scored with **CoNLL F1 (MUC/B-cubed/CEAF) + pairwise P/R**, with a
  hard **zero-false-merge** gate and a **B-cubed-precision** floor.
- **EVALSURF-3** Connect linking is scored with **micro-F1 (strong/InKB) + NIL accuracy**.
- **EVALSURF-4** Claims are scored with **claim precision (vs source) + atomicity/coverage**.
- **EVALSURF-5** Compose & Recall are scored with **faithfulness + per-citation attributability (AIS)**.
- **EVALSURF-6** Every numeric-confidence decider has a **calibration (ECE)** metric.
- **EVALSURF-7** The **act-vs-ask** decision is scored on a **risk–coverage frame (AURC +
  precision@coverage)**. The **confidence threshold (operating point) is a USER setting** (per
  stage), and the eval's risk–coverage curve supplies its **informed default** + the regression
  gate. The setting lives in the Control Panel alongside scale/model (SPEC-0048).
- **EVALSURF-8** An **ambiguous-case corpus** exists per stage; **surfacing precision/recall** is
  measured against it.
- **EVALSURF-9** Judge-based checks use a **different-family judge, order-swapped, κ-validated**.
- **EVALSURF-10** A **held-out/rotating slice** + leakage audit guards against overfitting. *(should)*
- **EVALSURF-11** Model/prompt swaps trigger a **full re-eval** including calibration/abstention.

## 11. Open decisions (Principal / KB-Lead)

- **D1 — Corpus origin:** how much own-vault (private, best signal, manual labeling) vs synthetic
  (fast, riskier)? Recommend own-vault for headline, synthetic for stress.
- **D2 — Abstention operating point:** what selective-risk@coverage do we commit to shipping?
- **D3 — Slice scope for v1:** start with **Connect (merge/link)** + **Recall (grounding)** — the
  two highest-blast-radius stages — then fan out? (Recommended.)
- **D4 — Calibration source:** surface decider confidence into vault metadata now (enables ECE), or
  defer until confidence is actually *used* (soft-floor) in the pipeline?
