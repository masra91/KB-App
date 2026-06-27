---
spec: SPEC-0049
key: HEAL
title: Self-healing deciders — converge-or-ask, never toss (eliminate set-aside-as-giving-up)
type: feature
status: draft
owners: [KB-Lead, Principal]
related: [SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0020, SPEC-0024, SPEC-0030, SPEC-0047]
created: 2026-06-13
stage: Cross-cutting
supersedes: null
---

# Self-healing deciders — converge or ask, never toss

> Set-aside has become a graveyard: **203 items** parked inert in the dogfood vault. Root cause is
> NOT model capability (opus-4.8 is wildly over-qualified for "split a note into entities") — it's a
> **process failure**: brittle one-shot JSON parsing, **no self-repair**, blind same-prompt retry,
> and a **hair-trigger 3-strike toss**. The Principal's directive: stop tossing. An item should
> **converge (self-heal/commit) or ask the human** — never silently die.

## 1. Evidence (dogfood vault, 2026-06-13)

- **203 set-aside items.** Dominant cause = malformed/truncated agent JSON (`Expected ',' or ']' …
  position 11715`). Our exec buffers are 4–8 MB; the failure is at ~11 KB → **not our truncation, the
  model returned imperfect JSON** and the parser had zero tolerance.
- Every decider parser: `JSON.parse(match[0])` (connect.ts:185, claims.ts:107, decompose.ts:124,
  copilotAgent.ts:85) — single regex match, raw parse, **no repair / no error-feedback retry**.
- On failure: blind retry of the SAME prompt, `maxAttempts=3` → set aside (DECOMP-6/ORCH-12).
- Second cause: `review-cascade-cap` (REVIEW-8, `MAX_REVIEW_ROUNDS=3`) — the agent kept raising
  reviews instead of committing → tossed (e.g. claims/Mochi).
- (Third, concurrency-only: `collision-exhausted`, ORCH-19 — rare; handled separately.)

## 2. Principle

**Over-qualified model + brittle harness = self-inflicted failures.** The fix is to make the harness
*ask the model to fix itself* and *coach it to commit*, not to give up. Set-aside stops being a
normal outcome; it survives only as a bounded safety backstop against true runaway (the #256 crash
class), which should essentially never fire.

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`

- **HEAL-1 Self-repair round.** On a parse/validation failure, the decider re-prompts with the
  **specific error fed back** ("your JSON failed at X / missing field Y — return corrected JSON")
  rather than blind-retrying the same prompt. Bounded (1–2 repair rounds) so it can't loop.
- **HEAL-2 Lenient extraction.** Tolerate fenced code blocks, leading/trailing prose, and minor
  recoverable malformations before a repair round is even needed (extract the JSON object robustly,
  not `match[0]` + raw parse).
- **HEAL-3 Coach-to-commit prompts.** Decompose/Connect/Claims prompts instruct the model to **make
  its best decision with a confidence score** and reserve a **review only when a human genuinely
  must choose** — reducing review cascades. (Reviews remain the legitimate human-input path; the
  Principal is fine with reviews — it's *tossing* that's unacceptable.)
- **HEAL-4 Raise/soften caps.** Raise `MAX_REVIEW_ROUNDS` and `maxAttempts` defaults (and make them
  configurable alongside SPEC-0048 scale settings). The numbers are a backstop, not the normal bar.
- **HEAL-5 Never silently toss.** When a cap *is* reached, the terminal outcome is a **best-effort
  low-confidence decision** or a **single "needs your decision"** — NEVER a silent set-aside.
  Set-aside as a user-visible dead-end is removed.
- **HEAL-6 Safety backstop preserved.** A bounded, high ceiling still prevents infinite-loop / cost /
  the #256 retry-forever OOM (crashCascade guarantees must stay green). It is a backstop that
  effectively never fires in normal use — not a routine outcome.
- **HEAL-7 Drain the graveyard.** A **bulk-retry** of existing set-aside items (now on opus-4.8 +
  self-repair) — most should clear. Report the residual rate.
- **HEAL-8 Optimistic Retry/Dismiss.** Today Retry/Dismiss (ipc OBS-17, claims-only) **awaits an
  under-lock git commit** before returning → multi-second lag. Make it **optimistic** (reuse the
  REVIEW-20 / SHELL-12 seam): the item **leaves the UI instantly**, re-enqueues, and the
  audit-append + re-run happen **async**; honest rollback on failure. Extend beyond claims to
  **Connect (and any set-aside)** — not claims-only.
- **HEAL-9 Reset cleans failure state.** A KB reset/replay must clear **set-aside + error + park
  state** (not carry the graveyard forward). A replayed/reset item starts clean.
- **HEAL-10 Full/hard reset.** A **"hard reset" option = wipe ALL derived state** (entities, claims,
  outputs, reviews, set-aside markers, spans/cache) **keeping ONLY the sources**, then **re-ingest
  from sources**. Audit log is **kept by default**, with an option for a *total* reset (everything
  but the re-ingested sources). Cross-ref SPEC-0022 (REPLAY).

## 4. Eval tie-in (SPEC-0047)
Toss-rate (set-asides per N items) becomes a tracked metric; target ≈ **0** on the headline corpus.
Self-repair success rate + review-vs-commit ratio are component-eval signals.

## 5. Notes
- Bumping to opus-4.8 alone does NOT fix this — a SOTA model can still emit one imperfect JSON and
  we'd still toss. HEAL-1/2 are required regardless of model.
- `collision-exhausted` (concurrency) is orthogonal — handled by the SPEC-0048 adaptive-concurrency
  collision-rate signal, not here.
