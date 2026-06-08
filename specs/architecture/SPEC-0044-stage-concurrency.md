---
spec: SPEC-0044
key: CONCUR
title: Stage Concurrency & User-Controlled Parallelism (reconciliation-backed)
type: architecture
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-08
updated: 2026-06-08
related: [SPEC-0014, SPEC-0015, SPEC-0016, SPEC-0019, SPEC-0020, SPEC-0022, SPEC-0023, SPEC-0024, SPEC-0027, SPEC-0030]
stage: Cross-cutting
supersedes: null
---

# Stage Concurrency & User-Controlled Parallelism

> Let the enrichment stages **race for throughput**, tell the user the trade-off, and lean on
> **Rumination (Reflect, SPEC-0024) as the eventual-consistency reconciler** — it already detects
> missed connections and merges duplicates (REFLECT-3/4/5/11), which happen *anyway* even serially.
> The architectural move: **trade strong-consistency-via-serialization for eventual-consistency-via-
> reconciliation** — bounded to the **derived** graph (ground truth stays strong + replayable).
> Motivated by a slow bulk watch-folder ingestion (Principal, 2026-06-08).

## 1. Intent (the why)

A bulk ingestion crawls. The Principal wants **customizable throughput** without the system pretending
the only safe pipeline is a serial one. The realization: the enrichment graph is **already eventually
consistent** — Connect can miss a cross-link or near-duplicate an entity even running serially, which is
exactly why **Reflect exists** (REFLECT-3 "missing/lost connections", REFLECT-5 merge/consolidate). So
concurrency doesn't *introduce* a new failure mode — it **raises the rate of an existing one that Reflect
already repairs.** That reframes the whole problem: don't serialize for correctness; **let it race, be
honest about the trade-off, and converge via Rumination.**

## 2. The architectural stance — what's strong vs eventually-consistent

The consistency boundary is the load-bearing decision:

| Layer | Consistency | Why it's safe |
| ----- | ----------- | ------------- |
| **Ground truth** — sources, the captured artifact + provenance | **STRONG, never raced** | immutable (DATA-2); the canonical **ff-advance stays serial** (ORCH-18); linear git history. A race can never lose or corrupt a source. |
| **Canonical git history** (`main`) | **STRONG** | one serial writer (ORCH-18); replayable (CANON-11) |
| **Derived enrichment graph** — entity *resolution*, cross-*links*, dedup | **EVENTUALLY consistent** | a concurrent pass may transiently leave a **duplicate entity** or a **missed link**; **Reflect converges it** (§4). And it's **rebuildable** (SPEC-0022 Replay) — the worst case is "re-derive," never "data lost." |

So concurrency is allowed **only on the derived layer**, whose errors are (a) the kind Reflect already
fixes and (b) non-destructive + replayable. Ground truth and git ordering keep their strong guarantees.

## 3. What can parallelize

Builds on the existing engine (ORCH-17 off-lock cognition · ORCH-20 per-stage cap · ORCH-23 the global
**Copilot ceiling**, the *real* throughput wall — a live A/B measured ~1.72× at cap 3 because Copilot
itself bottlenecks).

| Stage | Parallelize? | Race product (if any) → who reconciles |
| ----- | ------------ | -------------------------------------- |
| **Decompose** (source → candidates) | ✅ freely | none (disjoint per-source writes, ORCH-6) |
| **Claims** (entity → claims) | ✅ freely | none (disjoint per-entity writes) |
| **Connect** (resolve + dedup + link) | ✅ **now allowed** (was the serial point) | **duplicate entities + missed cross-links → Reflect** (REFLECT-5 merge, REFLECT-3/4 missed-link restore) |
| **Canonical ff-advance** | ❌ **stays serial** | n/a (ORCH-18 — linear history, non-negotiable) |

The change from the conservative model: **Connect may run concurrently.** Its resolution/dedup race
isn't *prevented* by serialization — it's *repaired* by Reflect. Throughput up; correctness converges.

## 4. The reconciliation contract — Reflect is the backstop (the linchpin)

Concurrency's correctness **depends on** Rumination. Reflect already does this (SPEC-0024) — we make the
dependency explicit and bidirectional:
- **Merge duplicate entities** — REFLECT-5 (destructive → Review under Guarded; **reuses Connect's merge
  machinery**). The resolution-race product.
- **Restore missed cross-links** — REFLECT-3 detects "missing/lost connections"; REFLECT-4 applies the
  **restored link** autonomously (additive, high-confidence). The link-race product.
- **Cross-source dedup / re-cluster** — REFLECT-11 (the convergence point; CONNECT-19 / CLAIMS-17).

**Therefore (CONCUR-3):** raising Connect concurrency **REQUIRES Reflect enabled + scheduled** — the
reconciler must actually run, or races accumulate unrepaired. And Reflect's **cadence scales with
ingestion/concurrency** (a big high-concurrency bulk run schedules more aggressive reconciliation, so
transient inconsistency converges in reasonable time, not eventually-someday).

## 5. User control + transparency

The Principal sets the throughput/consistency dial **knowingly**:
- **Per-stage concurrency** is user-customizable in the Control Panel (SPEC-0027), persisted per-Instance
  (PANEL-6), **bounded by the Copilot ceiling** (ORCH-23) — the UI is honest that a stage cap above the
  ceiling does nothing ("limited by the global model-call ceiling").
- **Honest trade-off, not a hidden footgun (CONCUR-4):** raising Connect concurrency shows a clear
  explanation — *"faster, but more transient duplicate-entities / missed-links that Rumination reconciles
  over time."* It's an informed choice, with the §2 reassurance that **nothing is lost** (ground truth +
  replay are safe).
- **A visible "reconciling" signal (CONCUR-5):** the user can see Reflect's reconciliation backlog (how
  much transient inconsistency is pending convergence) so a transiently-duplicated entity reads as
  *"Rumination will tidy this"*, not as a bug. Honest eventual-consistency UX.

## 6. Requirements

| ID | Priority | Statement (short) | Verify | Traces |
| -- | -------- | ----------------- | ------ | ------ |
| CONCUR-1 | must | **Per-stage concurrency is user-customizable** (Control Panel, persisted per-Instance), **bounded by the global Copilot ceiling** (ORCH-23); the UI is honest that a per-stage cap above the ceiling is inert | none-yet | ORCH-20,23; PANEL-6 |
| CONCUR-2 | must | Stages parallelize by **write-disjointness**: Decompose + Claims freely; **Connect MAY parallelize** (relaxed from serial — its race is reconciled, not prevented); the **canonical ff-advance stays serial** (ORCH-18) — concurrency is allowed **only on the derived, replayable layer**, never ground truth or git ordering | none-yet | ORCH-6,17,18; DATA-2; CANON-11 |
| CONCUR-3 | must | **Concurrency's correctness depends on Rumination.** Raising Connect concurrency **requires Reflect enabled + scheduled** (REFLECT-1); Reflect **reconciles the race products** — merge duplicate entities (REFLECT-5), restore missed links (REFLECT-3/4); its **cadence scales with ingestion/concurrency** so convergence stays timely | none-yet | SPEC-0024 REFLECT-1,3,4,5,11 |
| CONCUR-4 | must | **Honest trade-off, never a hidden footgun:** raising a stage's concurrency (esp. Connect) shows a **clear explanation** of the throughput-vs-transient-consistency trade-off + the §2 reassurance that **nothing is lost** (ground truth immutable, fully replayable) | none-yet | PRIN-19; AUTO-8 |
| CONCUR-5 | must | **Eventual-consistency is visible, not silent:** the user can see Reflect's **reconciliation backlog** (pending transient inconsistency) so a transiently-duplicated entity / missing link reads as *"Rumination will converge this,"* not a defect | none-yet | OBS-5; SPEC-0024 |
| CONCUR-6 | should | The **bottleneck is measured before tuning is exposed** — instrument a bulk run to attribute wall-clock (Copilot ceiling vs lock-contention vs serial stalls) so the concurrency dial targets the real wall (likely the Copilot ceiling, ORCH-23), not a placebo | none-yet | OBS-12,14 |

## 7. Open questions

- [ ] **Copilot-ceiling vs stage-caps as the real lever** — CONCUR-6: measure. If Copilot is the wall, the
      bigger win may be **batching multiple items per Copilot call** or a higher ceiling, not stage caps.
- [ ] **Connect concurrency default** — ship Connect concurrent-by-default (trusting Reflect), or
      opt-in-with-warning until Reflect's reconciliation is proven on real race volume?
- [ ] **Reflect cadence scaling** — what function of ingestion-rate/concurrency drives reconciliation
      cadence so convergence is timely without Reflect itself becoming the bottleneck?
- [ ] **Promotion batching** — promote N resolved items per ff-advance (vs one-at-a-time) may be a bigger,
      lower-risk throughput win than stage concurrency. Evaluate alongside.

## 8. Out of scope

- Concurrent canonical ff-advance (ORCH-18 — never).
- The #256/#163 lock-contention fixes (ORCH-25/26/27, in flight) — they remove a *stall*, not a ceiling.

## 9. Changelog

- 2026-06-08 — **reconciliation-backed model (Principal go-ahead to spec).** Reframed from the
  serialize-for-correctness exploration to **let-it-race + reconcile-via-Rumination**: concurrency is
  allowed on the **derived** layer (eventually consistent, replayable), ground truth + git ordering keep
  **strong** consistency. Connect is **relaxed from serial** — its duplicate-entity/missed-link race is
  **repaired by Reflect** (which already does this, REFLECT-3/4/5/11), not prevented; this is an *existing*
  failure mode whose rate concurrency raises, so Reflect is now a **declared dependency** (CONCUR-3). Adds
  user-customizable per-stage caps under the Copilot ceiling (CONCUR-1), an **honest trade-off UX**
  (CONCUR-4) + a visible **reconciliation backlog** (CONCUR-5), and a **measure-the-bottleneck-first**
  guard (CONCUR-6). Requirements may graduate into SPEC-0014 ORCH; the REFLECT dependency is mirrored in
  SPEC-0024.
- 2026-06-08 — created as EXPLORATION (not-ready); superseded above the same day by the Principal's
  go-ahead + the reconciliation insight.
