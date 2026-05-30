---
spec: SPEC-0000
key: SPECSYS
title: The Living Spec System
type: meta
status: active
owners: [KB-Architect]
created: 2026-05-30
updated: 2026-05-30
related: []
supersedes: null
---

# The Living Spec System

> The rules that make `specs/` a semantic test surface — written in the very
> format they describe, so the system is testable against itself.

## 1. Intent (the why / JTBD)

We (a human + an AI architect) are building KB-App incrementally over a long
period. We need a way to answer, at any moment, "does what we built still match
what we intended, and is it covered?" — without re-reading the entire codebase
from memory.

The job this system is hired for: **turn intent into something we can
continuously, mechanically, and semantically check the product against.** Specs
that can't be checked drift silently; this system is the anti-drift mechanism.

Without it: requirements live in chat logs and one person's head, tests cover
whatever was convenient, and "is it done / still correct?" becomes an opinion.

## 2. Scope

**In scope:**
- The structure, conventions, and lifecycle of spec documents.
- The requirement-ID and verification model that enables traceability.

**Out of scope (for now):**
- The actual checker tooling (`specs/tools/`) — designed-for, not yet built.
- Any product or tech content (those live in their own specs).

## 3. User flows / feature surface

The "users" are the architect (AI) and the maintainer (human).

**Primary flow — author a spec:**
1. Copy `TEMPLATE.md` to the right folder as `SPEC-NNNN-slug.md`.
2. Reserve the next number + a `key`; add a row to `INDEX.md`.
3. Write intent and flows first; let requirements fall out of the flows.
4. Mark each requirement's verification honestly (`none-yet` is fine early).

**Primary flow — check the surface:**
1. Read a spec's requirement table.
2. For each ID, follow `Verify:` to its test / manual proof / eval.
3. Anything `none-yet` or with a missing/broken link is an uncovered requirement.

**Secondary flow — evolve a requirement:**
- Change the statement → bump spec `updated`, add a changelog line.
- Remove a requirement → set it `withdrawn`; never reuse its ID.

## 4. Requirements

| ID        | Priority | Statement (short)                                   | Verify |
| --------- | -------- | --------------------------------------------------- | ------ |
| SPECSYS-1 | must     | Every spec has frontmatter with a unique `spec` + `key` | manual:review |
| SPECSYS-2 | must     | Requirements have stable IDs `<KEY>-N`, never reused | manual:review |
| SPECSYS-3 | must     | Every requirement declares a `Verify:` method        | manual:review |
| SPECSYS-4 | must     | Requirements use RFC-2119 normative keywords         | manual:review |
| SPECSYS-5 | must     | Specs carry a lifecycle `status`                     | manual:review |
| SPECSYS-6 | should   | `INDEX.md` lists every spec with its status          | manual:review |
| SPECSYS-7 | should   | Behavior changes update the relevant spec in the same change | manual:review |
| SPECSYS-8 | may      | A tool can extract IDs + verify methods to report coverage | none-yet |

### SPECSYS-1 — Specs are self-describing
- **Status:** active · **Priority:** must
- **Statement:** Every spec **MUST** begin with frontmatter containing a unique
  `spec` number and a unique uppercase `key`.
- **Rationale:** Identity is the anchor for traceability and cross-references.
- **Verify:** manual:review

### SPECSYS-2 — Requirements are stably addressable
- **Status:** active · **Priority:** must
- **Statement:** Each requirement **MUST** have an ID of the form `<KEY>-N` that is
  unique within the spec and **MUST NOT** be reused once retired.
- **Rationale:** Tests and history point at IDs; reuse silently corrupts coverage.
- **Verify:** manual:review

### SPECSYS-3 — Every requirement is verifiable
- **Status:** active · **Priority:** must
- **Statement:** Each requirement **MUST** declare a `Verify:` method
  (`test:`, `manual:`, `ai-eval`, or `none-yet`).
- **Rationale:** A requirement with no verification path can't be part of a test surface.
- **Verify:** manual:review

### SPECSYS-4 — Requirements are normative
- **Status:** active · **Priority:** must
- **Statement:** Requirement statements **MUST** use RFC-2119 keywords
  (MUST/SHOULD/MAY) so their truth value is checkable.
- **Rationale:** Ambiguous prose can't be passed or failed.
- **Verify:** manual:review

### SPECSYS-5 — Specs carry lifecycle
- **Status:** active · **Priority:** must
- **Statement:** Every spec **MUST** carry a `status` from the defined lifecycle.
- **Rationale:** We need to know what is binding vs. exploratory vs. dead.
- **Verify:** manual:review

### SPECSYS-6 — The index is complete
- **Status:** active · **Priority:** should
- **Statement:** `INDEX.md` **SHOULD** list every spec with its status and key.
- **Rationale:** A single registry is the entry point for humans and tools.
- **Verify:** manual:review

### SPECSYS-7 — Specs and code change together
- **Status:** active · **Priority:** should
- **Statement:** When behavior changes, the relevant spec **SHOULD** be updated in
  the same change set.
- **Rationale:** Anti-drift only works if the spec is part of "done."
- **Verify:** manual:review

### SPECSYS-8 — Mechanically checkable
- **Status:** active · **Priority:** may
- **Statement:** A future tool **MAY** parse specs to extract requirement IDs and
  verification methods and report coverage, orphans, and drift.
- **Rationale:** This is the eventual "and code" payoff of the conventions above.
- **Verify:** none-yet

## 5. Open questions

- [ ] Do requirement IDs need a global namespace, or is per-spec `<KEY>-N` enough
      long-term? (Currently: per-spec.)
- [ ] Should `Verify:` support multiple methods per requirement (e.g. a test *and*
      an eval)? (Currently: one primary; revisit if needed.)
- [ ] When do we build `specs/tools/` — at what spec count does manual review stop scaling?

## 6. Changelog

- 2026-05-30 — created (active). Establishes the spec system.
