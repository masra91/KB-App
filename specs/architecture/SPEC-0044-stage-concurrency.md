---
spec: SPEC-0044
key: CONCUR
title: Stage Concurrency & User-Controlled Parallelism (EXPLORATION — not ready to implement)
type: architecture
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-08
updated: 2026-06-08
related: [SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0019, SPEC-0020, SPEC-0023, SPEC-0027, SPEC-0030]
stage: Cross-cutting
supersedes: null
---

# Stage Concurrency & User-Controlled Parallelism

> ⚠️ **DESIGN EXPLORATION — NOT READY TO IMPLEMENT.** Captures the thinking so we can start it
> deliberately. No requirement here is dispatchable yet; the open questions in §6 gate any build.
> Motivated by a **bulk watch-folder ingestion that ran very slowly** (Principal, 2026-06-08).

## 1. Intent (the why)

Under a **bulk ingestion** (a watch folder dumped with hundreds of files), the pipeline crawls. The
Principal wants to (a) make throughput tunable, and (b) understand **which stages can safely run more
concurrently** — without **silently missing connections** because two enrichment passes raced.

This is an *exploration*, not a directive: concurrency is correctness-sensitive (the resolution stage
especially), so we spec the **analysis + guardrails + user-control model** first, and gate implementation
on the open questions.

## 2. What already exists (don't re-spec)

Concurrency is **already in the engine** (SPEC-0014 ORCH):
- **ORCH-17** — stages run cognition + worktree writes **off the lock**, concurrently.
- **ORCH-20** — a **configurable in-flight cap** per stage (`STAGE_CAP`); cap=1 = serial drain.
- **ORCH-18** — only the **canonical ff-advance** serializes behind the one writer lock.
- **ORCH-23** — a **process-wide Copilot-concurrency ceiling** (`withCopilotSlot`) bounds total
  `copilot` subprocesses; **this is the real throughput wall** — a live A/B measured only **~1.72× at
  cap 3** because *Copilot itself is the bottleneck*, not the per-stage cap.

**Implication:** raising per-stage concurrency helps **only up to the Copilot ceiling**. A bulk
ingestion is slow primarily because **every enrichment step is a multi-second Copilot call** (observed
**11–20 s per claims call**) and there are thousands of them — not because the stages are serial. So
"more concurrency" is partly a **Copilot-ceiling** question, not just a stage-cap question.

## 3. Stage-by-stage: what can parallelize, and the risk

The load-bearing analysis. **Parallelism is safe when items have disjoint write paths (ORCH-6) AND no
cross-item reasoning; it is dangerous where a stage must see the *whole picture* to be correct.**

| Stage | Per-item independent? | Safe to parallelize? | The risk if you do |
| ----- | --------------------- | -------------------- | ------------------ |
| **Decompose** (source → candidates) | ✅ each source independent | **Yes** — disjoint candidate writes | low; bounded by Copilot ceiling |
| **Claims** (entity → claims) | ✅ each entity's claims independent | **Yes** — disjoint per-entity claim writes | low; bounded by Copilot ceiling |
| **Connect / Link** (candidates → resolve + dedup + link entities) | ❌ **must see the whole candidate set** | **NO — correctness-critical** | **the Principal's "missing gaps": two mentions of the *same* real entity resolved in parallel → TWO duplicate nodes instead of one merge; cross-links missed because each run is blind to the other's in-flight entities** |
| **Promotion / canonical ff-advance** | n/a | **No — must stay serial** | linear history / no races (ORCH-18) — non-negotiable |

**The key insight:** **Connect is the serialization point for *correctness*, not just for the lock.**
Resolution + dedup is inherently a "needs global view" operation — it's `cap=1` today for exactly this
reason. Decompose and Claims are the stages where extra concurrency is *safe* and *helps*.

## 4. The risk model — "missing gaps" (race conditions in enrichment)

What the Principal named. Concretely, parallelizing the resolution path risks:
1. **Duplicate entities** — two candidates for the same real entity resolved concurrently each mint a
   new node (the dedup/blocking check didn't see the other in flight).
2. **Missed cross-links** — entity A links to B, but B was created by a *concurrent* Connect run A
   never saw → the edge is never drawn (dots, no edges — the exact symptom).
3. **Lost-update on a shared entity** — two claims passes update the same entity node's blocks
   concurrently → one clobbers the other (mitigated today by disjoint paths + the lock, but a naive
   concurrency bump could reintroduce it).

**Mitigation directions (to evaluate before implementing):**
- Keep **Connect serial (cap 1)** by default; parallelize only Decompose/Claims.
- If Connect must scale: **deterministic blocking keys** (partition candidates by a stable key so
  same-entity candidates always land in the same Connect batch — never raced across batches) + a
  **post-hoc dedup/repair pass** (Reflect, SPEC-0024) as a safety net for any missed merge.
- **Never** let the canonical ff-advance go concurrent (ORCH-18 holds).

## 5. User control (the Principal's ask)

A **per-stage concurrency control** the Principal tunes to their machine/usage — with **guardrails**:
- Surfaced in the **Control Panel** (SPEC-0027) — a per-stage concurrency setting, persisted per-Instance.
- **Decompose / Claims** — freely tunable up to the **Copilot ceiling** (ORCH-23); above the ceiling has
  no effect (be honest in the UI: "limited by the global model-call ceiling").
- **Connect** — **guard-railed**: default low (1); raising it shows a **clear warning** that it risks
  **duplicate entities + missed connections**, and is gated on the §4 mitigations existing.
- The **global Copilot ceiling** (ORCH-23) is the master knob; per-stage caps live under it. The UI must
  make the relationship legible (per-stage cap ≤ what the ceiling allows) so a user isn't surprised that
  bumping a stage did nothing.

## 6. Open questions — GATE implementation (why this is not-ready)

- [ ] **Is the bottleneck even concurrency?** Measure a bulk run: is wall-clock dominated by the Copilot
      ceiling (then the answer is the ceiling, not stage caps), by lock contention (then it's the #256/#163
      lane — already being fixed), or by genuine serial stalls? *Spec nothing until this is measured.*
- [ ] **Connect scaling** — is deterministic-blocking + post-hoc-dedup worth the complexity, or does
      Connect simply stay serial (and we accept it as the correctness throttle)?
- [ ] **Copilot ceiling headroom** — ORCH-23 measured ~1.72× at cap 3; what's the real ceiling on the
      Principal's hardware, and is a higher ceiling (or batching multiple items per Copilot call) the
      bigger lever than stage caps?
- [ ] **Where do per-stage caps live + persist** (ties to PANEL-6 instance config)?
- [ ] **Does promotion batching help?** (promote N resolved items per ff-advance vs one-at-a-time) —
      possibly a bigger throughput win than stage concurrency, and lower risk.

## 7. Out of scope

- Concurrent canonical ff-advance (ORCH-18 — never).
- The #256/#163 lock-contention fixes (separate; ORCH-25/26/27, in flight) — they remove a *stall*, not a
  concurrency *ceiling*.

## 8. Changelog

- 2026-06-08 — created as **EXPLORATION (not ready to implement)**, per the Principal's bulk-ingestion
  slowness + "start thinking on concurrency, mark not-ready." Captures: the existing model (cognition
  already concurrent; Copilot ceiling is the real wall, ORCH-23), the **stage-by-stage parallelism-safety
  analysis** (Decompose/Claims safe; **Connect correctness-critical → the "missing gaps" race**; ff-advance
  serial), the risk model, and a **guard-railed per-stage user-control** model. Implementation gated on the
  §6 measurements — *measure the real bottleneck before building.* When ready, requirements graduate into
  SPEC-0014 ORCH.
