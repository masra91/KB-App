---
spec: SPEC-0035
key: HEALTH
title: Knowledge Health & Structural Lint
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-03
updated: 2026-06-03
related: [SPEC-0007, SPEC-0018, SPEC-0019, SPEC-0020, SPEC-0023, SPEC-0024, SPEC-0029, SPEC-0030, SPEC-0031, SPEC-0032]
stage: Reflect
supersedes: null
---

# Knowledge Health & Structural Lint

> A **deterministic** vault-graph linter that keeps the *materialized* KB structurally clean —
> no broken links, orphans, stubs, malformed wikilinks, or path-polluted filenames — for
> **near-zero cost (no model calls)**. It is the cheap, always-on **complement** to REFLECT's
> agent-judgment maintenance: HEALTH finds and fixes the *structural* rot mechanically; anything
> needing *content* judgment (adopt an orphan, expand a stub, write a missing alias) is handed to
> REFLECT, which already owns the auto/Review disposition split.

## 1. Intent (the why / JTBD)

An agent that *writes* a wiki continuously degrades it the way a hand-kept one does — only faster,
because volume is higher. Dead `[[links]]` accumulate when a target is merged/renamed; nodes go
**orphan** when a connection is lost; **stub** pages linger; malformed links and path-polluted
filenames creep in. JTBD: *"keep my vault structurally clean on its own — I should never open
Obsidian to a graph full of broken links and orphans."*

The insight that makes this cheap: **most health problems are structural, not semantic, and are
detectable (and often fixable) with no LLM at all.** Spending an agent call to notice a dead link
is waste. HEALTH does the free, deterministic part constantly; only genuine *content* repair costs
a model call, and that part is REFLECT's existing job — so HEALTH adds **no new judgment
machinery**, just a fast graph linter and a disciplined repair order.

## 2. Scope

**In scope:**
- A **deterministic structural scan** over the canonical link/file graph (entities/claims/links).
- **Deterministic auto-fixes** for purely-structural issues (no content invention).
- **Handoff** of content-judgment repairs to REFLECT (orphan adoption, stub expansion, alias
  completion) — never a second judgment engine.
- A **causality-ordered repair sequence** so a fix can't manufacture a downstream violation.
- Running as a **bounded, audited job** (SPEC-0023), with opt-in triggers.

**Out of scope (for now):**
- **Semantic** detection (missed entities, emergent topics, lost-but-meaningful connections) —
  that is **REFLECT** (SPEC-0024), agent judgment.
- **Dedup/merge** of duplicate nodes — that is **CONNECT** (SPEC-0020); HEALTH may *surface* a
  likely structural duplicate but does not fuse.
- **Contradiction** detection/resolution — that is **CONTRA** (SPEC-0036).
- Inventing content — HEALTH never writes prose; structural fixes only (content repair is REFLECT).

## 3. The check catalog (deterministic)

| Issue | Deterministic detection | Disposition |
| --- | --- | --- |
| **Dead link** | `[[target]]` resolves to no node (after alias resolution) | **Auto-fix**: repoint to a known alias of the intended node; else flag → Review |
| **Malformed link** | nested/escaped wikilinks (`[[[[…]]]]`), stray brackets | **Auto-fix**: rewrite to canonical `[[path\|Name]]` |
| **Path-polluted name** | folder prefix leaked into filename/title (e.g. `concepts/concepts-foo.md`) | **Auto-fix**: rename + repoint all refs |
| **Orphan** | node with **0 inbound and 0 outbound** links | **Queue → REFLECT** (adopt: find/justify connections) |
| **Stub / empty** | node body below a content threshold | **Queue → REFLECT** (expand from its source(s)) |
| **Missing alias** | node with no `aliases` (SPEC-0007 enabler) | **Queue → REFLECT** (alias completion) |

Deterministic auto-fixes (top three) cost **no model call**; the bottom three are *content* repairs
**queued as REFLECT findings**, where the guarded auto/Review split (REFLECT-4/5) applies.

## 4. Requirements

| ID       | Priority | Statement (short) | Verify | Traces |
| -------- | -------- | ----------------- | ------ | ------ |
| HEALTH-1 | must | A **deterministic** scan of the canonical link/file graph detects the §3 catalog (dead links, malformed links, path-polluted names, orphans, stubs, missing aliases) **with no model calls** | healthPanel.test (v1: dead links · orphans · thin stubs) | LIFE-8; PRIN-5; VAULT |
| HEALTH-2 | must | Purely-**structural** issues are **auto-fixed deterministically** — never inventing content: rewrite malformed links, repoint dead links to a known alias, normalize polluted filenames + repoint all refs | none-yet | DATA-9; VAULT; CONNECT |
| HEALTH-3 | must | Issues needing **content judgment** (orphan adoption, stub expansion, alias completion) are **queued as REFLECT findings** — HEALTH adds **no** second judgment/auto-apply engine; REFLECT's guarded auto/Review split governs them | none-yet | SPEC-0024 REFLECT-3,4,5 |
| HEALTH-4 | must | Repairs run in a **causality order** (normalize names → complete aliases → dedup/merge → fix dead links → adopt orphans → expand stubs); each stage **settles before the next** so an earlier fix can't spawn a downstream violation | none-yet | ORCH-3 |
| HEALTH-5 | must | HEALTH runs as a **bounded, single-flight, audited job** on the SPEC-0023 engine, writing on `staging` and publishing via the gate (deletion-aware for renames/repoints) | none-yet | JOBS-1,3,5; STAGING; CANON |
| HEALTH-6 | should | **Triggers:** a **scheduled** sweep always; **opt-in** on-idle / on-startup (default OFF) | none-yet | JOBS-4 |
| HEALTH-7 | must | Every fix is **append-only audited** (the *what* + the *why*); structural auto-fixes are reversible via history (no source/identity mutation — CLAIMS-11 analogue) | none-yet | AUDIT-2; DATA-2 |
| HEALTH-8 | should | Health findings + the running fix-pass are **visible in the Status surface**; anything a deterministic fix can't safely resolve routes to the **#192 needs-you queue** | healthView.test (v1: a dedicated read-only Health view; fix-pass + needs-you routing pending the fix slice) | SPEC-0030 OBS; SPEC-0032 VIZ-7; SPEC-0018 |
| HEALTH-9 | should | A **`protected` / human-edited** node is **never overwritten** by a structural auto-fix beyond reference-repointing (a human edit is sacred; only links pointing *at* it are repaired) | none-yet | PRIN-19; AUTO-1 |

## 5. Key user flows / surface

- A target node is merged away → its inbound `[[links]]` would dangle → HEALTH **repoints** them to
  the survivor's alias deterministically; no graph rot, no model call.
- A node ends up with zero links → HEALTH flags **orphan** → queues a REFLECT finding → REFLECT
  adopts it (auto) or asks you (Review).
- Open **Status** → "Health: 0 dead links · 2 orphans queued · 1 stub queued" — a calm, legible
  health readout, not a wall of red.

## 6. Out of scope (for now)

- Semantic maintenance (REFLECT), dedup/merge (CONNECT), contradictions (CONTRA) — HEALTH is the
  *structural* layer only.
- Content generation of any kind (that's REFLECT's queued repairs).

## 7. Open questions

- [ ] **Stub threshold** — what content size counts as a stub (chars? claim-count? both)?
- [ ] **Orphan grace** — should a brand-new node get a grace period before it's flagged orphan
      (it may be mid-enrichment)?
- [ ] **Dedup overlap** — when HEALTH spots a likely *structural* duplicate (same normalized name +
      alias), does it hand to CONNECT's cheap-first dedup tier, or just surface it?
- [ ] **Run cadence** — HEALTH as its own job vs. a deterministic pre-pass *inside* each REFLECT run.

## 8. Changelog

- 2026-06-27 — **v1 passive dashboard built** by KB-Developer-4 (Principal: all devs flowing). The
  read-only **detect + surface** half: a deterministic, **no-model-call** scan (`kb/healthPanel`)
  over the canonical graph flags **orphans** (0 in/0 out), **dangling/dead links** (target resolves
  to no node after alias resolution), and **sparse/thin stubs** (prose body, machinery stripped,
  below `THIN_BODY_CHARS`); a dedicated read-only **Health view** renders the calm §5 readout +
  per-issue sections with click-through to the node. **Deferred to a later slice** (explicitly not
  v1): deterministic auto-fixes (HEALTH-2), causality-ordered repair (HEALTH-4), the bounded audited
  job + staging/gate publish (HEALTH-5), the REFLECT handoff for content repairs (HEALTH-3), the
  remaining §3 checks (malformed links, path-polluted names, missing aliases). Gates: QD-2 code +
  Design-Lead visual.
- 2026-06-03 — created (draft). The **deterministic structural-lint** layer: a free, always-on
  vault-graph linter (dead/malformed/polluted/orphan/stub/missing-alias) that auto-fixes structural
  rot and **queues content repairs to REFLECT**, in a causality-ordered, audited, bounded job.
  Complements (does not duplicate) REFLECT's judgment maintenance. From the Principal's
  knowledge-health capability review.
