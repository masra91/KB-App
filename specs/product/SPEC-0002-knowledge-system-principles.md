---
spec: SPEC-0002
key: PRIN
title: Knowledge System Principles
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0001]
supersedes: null
---

# Knowledge System Principles

> The durable values of the KB. These tell future-us (and future agents) **how to
> think about decisions** without prematurely constraining the design. Every
> feature spec must be checkable against these — a feature that violates a `must`
> principle is wrong even if it "works."

## 1. Intent (the why / JTBD)

We are building a durable, AI-native knowledge system that will outlive the models
and tools used to build it. The principal's job-to-be-done for *this* document:
encode the non-negotiable values so that years of incremental decisions stay
coherent, and so any agent can self-check its work against a fixed reference.

**Guiding philosophy (verbatim):** *Build a durable, AI-native knowledge system
that preserves evidence, records provenance, respects uncertainty, protects
sensitive information, and remains understandable, auditable, and adaptable over
time.*

## 2. Scope

**In scope:** cross-cutting values and the normative requirements they imply.

**Out of scope:** how any of this is implemented (architecture specs), and which
features exist (feature specs). Those *reference* these principles.

## 3. How to use this spec

- Each principle keeps the Principal's original statement and implications.
- Each implication is rendered as a requirement `PRIN-N` so features can declare
  which principles they satisfy or are constrained by.
- IDs are stable. During product sketching, verification is `none-yet` — these
  become real tests/evals as features land.

## 4. The principles

### Principle 1 — Ground Truth is Sacred
The system is built upon immutable source material. Original documents, recordings,
messages, images, and other primary artifacts are preserved and never replaced by
derived outputs. All conclusions, summaries, and insights should be traceable back
to evidence. When uncertainty exists, it should be surfaced rather than concealed.

| ID     | Priority | Statement (short)                                  | Verify   |
| ------ | -------- | -------------------------------------------------- | -------- |
| PRIN-1 | must     | Primary & secondary sources are preserved, never replaced by derived outputs | none-yet |
| PRIN-2 | must     | Conclusions/summaries/insights are traceable to evidence | none-yet |
| PRIN-3 | should   | The system distinguishes facts, interpretations, and hypotheses | none-yet |
| PRIN-4 | must     | Uncertainty is surfaced, not concealed             | none-yet |

### Principle 2 — Provenance and Auditability are First-Class
Every artifact, transformation, and decision should have a discoverable lineage.
The system should make it possible to understand what happened, why, and how a
result was produced. Knowledge should be reproducible, inspectable, and recoverable.

| ID     | Priority | Statement (short)                                  | Verify   |
| ------ | -------- | -------------------------------------------------- | -------- |
| PRIN-5 | must     | Inputs, outputs, and transformations are recorded  | none-yet |
| PRIN-6 | must     | Agent actions and workflow execution are tracked   | none-yet |
| PRIN-7 | must     | Entities maintain version history                  | none-yet |
| PRIN-8 | should   | The system supports rollback, replay, and recovery | none-yet |

### Principle 3 — AI is an Operator, Not an Authority
AI agents perform the majority of organizational, analytical, and maintenance work.
However, agent outputs are treated as derived artifacts rather than sources of
truth. Trust comes from evidence and provenance, not from model confidence.

| ID      | Priority | Statement (short)                                 | Verify   |
| ------- | -------- | ------------------------------------------------- | -------- |
| PRIN-9  | must     | Agent outputs are derived artifacts, not sources of truth | none-yet |
| PRIN-10 | must     | Derived artifacts preserve links to supporting evidence | none-yet |
| PRIN-11 | should   | Agent confidence/uncertainty is tracked           | none-yet |
| PRIN-12 | should   | Agent performance is continuously evaluated       | none-yet |

### Principle 4 — Design for Longevity
The system should remain useful despite changes in models, tools, vendors, and
workflows. Knowledge must outlive the technologies used to process it.
Architectural decisions should favor durability, portability, and adaptability.

| ID      | Priority | Statement (short)                                 | Verify   |
| ------- | -------- | ------------------------------------------------- | -------- |
| PRIN-13 | must     | Knowledge is stored in open, durable formats      | none-yet |
| PRIN-14 | must     | Knowledge is not coupled to a specific tool/vendor; components are replaceable | none-yet |
| PRIN-15 | should   | Sources can be reprocessed as models improve      | none-yet |

### Principle 5 — Simplicity Over Cleverness
Complexity carries long-term operational cost. New capabilities should justify
their maintenance burden and cognitive overhead. The architecture should be
understandable, observable, and approachable by both humans and agents.

| ID      | Priority | Statement (short)                                 | Verify   |
| ------- | -------- | ------------------------------------------------- | -------- |
| PRIN-16 | should   | New capabilities justify their maintenance/cognitive cost | none-yet |
| PRIN-17 | should   | Workflows are explicit and observable; abstractions minimized | none-yet |
| PRIN-18 | should   | The system is built incrementally                 | none-yet |

### Principle 6 — Security and Privacy by Design
The system is expected to contain sensitive personal, professional, and
business-critical information. Confidentiality, access control, and responsible
handling are foundational. Security should be integrated into the architecture
rather than added later.

| ID      | Priority | Statement (short)                                 | Verify   |
| ------- | -------- | ------------------------------------------------- | -------- |
| PRIN-19 | must     | Both source material and derived knowledge are protected | none-yet |
| PRIN-20 | must     | Access follows least-privilege patterns           | none-yet |
| PRIN-21 | must     | Security is integrated into the architecture, not bolted on | none-yet |

### Principle 7 — Continuous Improvement Through Reflection
The system should generate knowledge not only about the world, but about itself.
Workflows, agents, prompts, and processes should be observable and subject to
ongoing evaluation. The KB should become more reliable, efficient, and useful over
time.

| ID      | Priority | Statement (short)                                 | Verify   |
| ------- | -------- | ------------------------------------------------- | -------- |
| PRIN-22 | should   | Workflows, agents, and prompts are observable and evaluable | none-yet |
| PRIN-23 | should   | Coverage gaps, failures, and lessons learned are captured and fed back | none-yet |

## 5. Open questions

- [x] PRIN-3 (facts vs. interpretations vs. hypotheses) — resolved (SPEC-0007 §4):
      first-class but lightweight **epistemic attributes** (status + confidence +
      evidence) on derived knowledge.
- [ ] PRIN-7 "Entities maintain version history" vs. PRIN-1 "sources are immutable":
      sources don't version (they're append-only/immutable); *derived* entities do.
      Confirm the split. (Ties to the Source↔Entity open question in SPEC-0001.)
- [ ] PRIN-20 least-privilege: privilege *for whom*? Multiple agents with scoped
      access to subsets of the KB? Single-principal for now?
- [ ] PRIN-12 / PRIN-22 evaluation: does "continuous evaluation" of agents tie into
      the living-spec semantic test surface (SPEC-0000)? Likely yes — note the link.

## 6. Changelog

- 2026-05-30 — created (draft). Captured the 7 principles + guiding philosophy from
  the Principal; rendered implications as requirements PRIN-1..PRIN-23.
