---
spec: SPEC-0054
key: RMEM
title: Researcher Memory & KB-Grounding (fit-and-fill, don't repeat, resume)
type: feature
status: draft
owners: [KB-Lead, Principal]
related: [SPEC-0028, SPEC-0005, SPEC-0047, SPEC-0051, SPEC-0024]
created: 2026-06-27
stage: Enrich
supersedes: null
---

# Researcher Memory & KB-Grounding

> **Principal:** *"make the researchers aware of the current repo and their own past runs so they
> don't just do generic shit — they fit and fill the KB, but also know where they were looking
> before and stopped, so they don't do the same thing over and over."*

This is **RESEARCH-QUALITY slice-2**. Slice-1 (#381, on `main`) made the trigger gap-aware,
populated the notebook `frontier`, and added cross-run angle rotation. This slice makes the
researcher's **memory durable + first-class** and its **KB-grounding explicit**, so output *fits*
the KB (fills real gaps) and never repeats a prior run.

## 1. The two capabilities
1. **KB-grounding (fit + fill).** Before researching, the researcher reads the *current* KB state
   for the target — what's already known, what facets/relationships are missing — and aims the run
   at the **gap**, not a generic restatement. The gap descriptor (from `enrichGap`, SPEC-0047) is
   the steering input.
2. **Run-memory (don't repeat, resume).** Each researcher keeps a **durable run-ledger**: what it
   already drilled (topic + gap facet + angle), which sources it harvested, and the **frontier**
   (leads seen but not yet pursued). A new run consults the ledger → skips covered ground, advances
   the frontier, resumes where it stopped.

## 2. Durability & boundaries
- The run-ledger is a **durable, per-researcher artifact** (survives restart/reset; evergreen, not
  staging-scoped) — the prior bug was a notebook that never persisted/reset cleanly.
- **Least-privilege egress is unchanged (D6a, SPEC-0005):** the researcher steers with the *gap
  descriptor and its own prior-run metadata*, **never** by dumping raw KB content into the outbound
  query. KB-grounding is an *input to angle/gap selection*, not an egress payload.
- On **replay/reset**, the ledger is rebuilt/honored per the REPLAY rules (re-applied, not
  re-derived-as-evidence) — directives-style overlay, not a source.

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`
- **RMEM-1** Before a run, the researcher reads the target's current KB state (existing
  claims/facets/relationships) and derives the **missing** facets/relationships as the run's aim.
  `Verify: none-yet → test:`
- **RMEM-2** A researcher keeps a **durable per-researcher run-ledger** recording, per run: target,
  gap facet pursued, angle, and harvested source ids. Survives restart + reset. `Verify: none-yet → test:`
- **RMEM-3** A new run **consults the ledger and does not repeat** a covered (target × gap-facet ×
  angle) tuple — it advances to an uncovered facet or the frontier. `Verify: none-yet → test:`
  (anti-regression: two runs on the same target produce materially different, non-overlapping aims —
  extends `gapOrientEval.queryDiversity`.)
- **RMEM-4** The **frontier** (leads surfaced but not pursued) persists across runs and is drained
  over time — a researcher can **resume where it stopped**. `Verify: none-yet → test:`
- **RMEM-5** Output **fits the KB**: a run targeting a flagged gap measurably reduces that gap
  (fills the missing facet) rather than re-asserting known facts. `Verify: none-yet → test:`
  (metric: gap-closure rate, in EVALSURF/SPEC-0047.)
- **RMEM-6** **Egress posture unchanged (D6a):** outbound queries are built from the gap descriptor +
  run metadata, never raw KB content; verified by the existing egress cassette/guard. `Verify: none-yet → test:`
- **RMEM-7** Ledger + frontier honor **reset/replay** (re-applied overlay, not decomposed as a
  source; reset clears them cleanly — no graveyard). `Verify: none-yet → test:`
- **RMEM-8** (should) The researcher's manage view surfaces a brief **run history** (what it has
  covered / what's on the frontier) so the Principal can see it isn't spinning. `Verify: none-yet → test:`

## 4. Relationship to other specs
- **SPEC-0028 RESEARCH** — parent; this is its quality slice-2 (slice-1 = #381).
- **SPEC-0047 EVALSURF** — supplies the gap descriptor + houses the gap-closure / diversity metrics.
- **SPEC-0051 COHERE** — gap/cohesion signals can inform which entities are worth a research run.
- **SPEC-0005 SCOPE** — the egress/least-privilege constraint this must not violate.

## 5. Out of scope
- Cross-researcher shared memory (each researcher's ledger is its own in v1).
- Proactive "research everything sparse" sweeps beyond the existing trigger cadence.

## 6. Delivery slices
- **Slice-A — the durable run-ledger + eval (this PR).** A first-class per-researcher ledger
  (`researchLedger.ts` → `.kb/research/<id>/ledger.json`) the run phase writes on every pass (RMEM-2);
  orient consults it (authoritative over the audit-derived notebook) to skip covered tuples + resume the
  frontier (RMEM-3/4); reset/replay overlay semantics — survives restart + replay, a deleted researcher
  leaves no graveyard (RMEM-7); the `gapClosureRate` metric (RMEM-5); egress posture guard (RMEM-6).
- **Slice-B (deferred).** RMEM-8 manage-view run-history surface; RMEM-1 *relationship*-gaps (today
  `enrichGap` derives missing *facets* only — relationship-gap detection is the follow-up).

## 7. Changelog
- 2026-06-28 — **Slice-A implemented** (KB-Developer-2). New `researchLedger.ts`: a durable, first-class
  per-researcher run-ledger (target × gap-facet × angle × harvested × outcome), bounded + self-healing,
  living under `.kb/research/<id>/` (neither gitignored nor in the replay clean-scope → survives restart +
  replay as a re-applied overlay, RMEM-2/7). `researchRun` records a run on every pass (finding/no-finding/
  failed); `researchOrient` reads the ledger and unions its covered-angles (RMEM-3 exclusion — a *failed*
  pass doesn't suppress a retry; stale facets re-open) + frontier (RMEM-4 resume) with the audit-derived
  notebook, so rotation is now ledger-backed. `deleteResearcher` clears `.kb/research/<id>/` (RMEM-7 no
  graveyard; ground truth — sources/findings + audit — untouched). New `gapClosureRate`/`runClosesGap`
  metric in `gapOrientEval` (RMEM-5): proves runs FILL the gap (drain the missing set), not just differ —
  the dead rail (re-asserting the first facet) collapses to `1/total`. Egress unchanged (RMEM-6): orient
  steers with the gap descriptor + run metadata only, never raw KB content (tested: the oriented query
  carries the facet, never harvested source ids). `Verify` graduates to `test:` for RMEM-2/3/4/5/6/7.
  **Deferred:** RMEM-1 relationship-gaps + RMEM-8 run-history UI (Slice-B). **Design note (D):** RMEM-2
  "survives reset" vs RMEM-7 "reset clears cleanly" resolved as the **directives-style overlay** — the
  ledger survives restart + the replay-rebuild (re-applied, not re-derived-as-evidence), while an explicit
  researcher delete clears it cleanly. Tunable by KB-Lead.
