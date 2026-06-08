---
spec: SPEC-0005
key: SCOPE
title: Contexts, Scopes & Surfacing
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0001, SPEC-0002, SPEC-0003, SPEC-0004, SPEC-0043]
supersedes: null
---

# Contexts, Scopes & Surfacing

> How a single-principal KB keeps the cross-connection magic while guaranteeing that
> sensitive knowledge never leaks into the wrong output and specious connections
> never get asserted as fact. Resolves cross-cutting **Fork 1**.

## 1. Intent (the why / JTBD)

This is *one principal's* second brain, so the threat model is not access-control
between people — it's two things the principal fears:

- **Output surfacing leaks** — a derived artifact (report, note, answer) that
  includes content it shouldn't, in front of the wrong audience. *Real examples:* a
  draft containing "we are skeptical of Steve's design" (candid private opinion); a
  note that surfaces "Gary said project XYZ will be cut next week" to people on that
  team (embargoed / need-to-know).
- **Specious connections** — the KB asserting a relationship that isn't really there,
  because cross-connection ran without enough evidence/metadata to scope it.

The principal *loves* cross-connection (it's the core of the day-in-the-life story),
so the answer is not isolation — it's **cross-connection with enforced guardrails**.

## 2. Two-layer model

Two different *kinds* of boundary, stacked:

### Layer 1 — Instance / Deployment (physical, hard)
An **Instance** is one installation of the app bound to **one vault** plus its own
agents, sources, config, on one machine / trust domain. Instances are **hard-
isolated**: no automatic data flow between them.

In practice there will be **≥2 instances** — a **Work** instance (work machine +
enterprise servers, where enterprise data must stay) and a **Personal** instance
(personal device). This is a *data-residency constraint*, not a modeling choice.

> Any bridge between instances is an **explicit, manual Principal action** (e.g.
> sanitized export) — deferred/out of scope for now.

### Layer 2 — Scope + Sensitivity (logical, enforced, within an Instance)
Within a single instance, the unified graph keeps full cross-connection, but two
first-class governed labels apply: **Scope** and **Sensitivity**. *Both your
nightmare examples happen inside the single Work instance, so this layer — not the
instance split — is what prevents them.*

## 3. Scope

- **Scope = the *area* something belongs to**, and the unit an agent/source/task can
  be **bound to**. User-defined (`Project Atlas`, `Client Acme`, `Journal`,
  `Trip: Japan 2026`). **Default = `global`**; most things live there, and the
  Principal opts into a named scope when something clearly belongs to a project/domain.
- An entity has **one primary scope** (default `global`). **Links MAY cross scopes** —
  that's where cross-connection lives.
- **Cross-scope links are allow-but-flag:** permitted, marked as cross-scope, and
  **low-confidence** cross-scope links are routed to **Review** ("are these really
  related?") rather than asserted.
- **Query-time scoping:** a query MAY be constrained to `global`, a single scope, or a
  Principal-specified **set** of scopes.
- Scope is **distinct from Tag** (set membership, descriptive, inert) and from
  **Sensitivity** (classification). How scope is *physically represented* (frontmatter
  field, folder, tag convention) is an **architecture decision, deferred**.

## 4. Sensitivity

- **Sensitivity = how protected an entity is in outputs.** Default label set:

  | Label | Meaning |
  | ----- | ------- |
  | `shareable` | fine in any output |
  | `internal` | fine internally; not external |
  | `confidential` | restricted; named need-to-know |
  | `private-opinion` | candid takes on people/work; never in a produced artifact unless explicitly requested |
  | `embargoed` | true but time/audience-gated (e.g. Gary's project-cut) |

- **Custom labels supported:** the system treats sensitivity labels as **data, not
  hard-coded values**, so the default set can be extended later.
- **Default on capture = `internal`** (conservative; unknown ≠ shareable).
- **Assignment:** a label is applied **at ingestion** when there's an **explicit or
  high-confidence signal**; otherwise it stays at the conservative default. Agents
  classify with a **confidence score**; **uncertain** classifications and **suggested**
  labels route to **Review**; the **Principal may override anytime**.
- **Connectors as a signal:** a data connector/source carries **default scope +
  sensitivity** that it applies to everything it ingests (e.g. a work-email connector
  → `Work` scope, `internal`). Connector identity is itself a high-confidence
  classification signal. Note "internal" is *relative per connector* (SCOPE-14).
- **Propagation (load-bearing):** a derived artifact **inherits the most restrictive
  sensitivity of its sources by default** — sensitivity is contagious *up* the
  derivation chain. The Principal may explicitly **downgrade** a derived artifact's
  sensitivity (a form of override).

## 5. Surfacing policy

- Every derived **output** declares an **audience/purpose** that maps to an **allowed
  sensitivity ceiling** (e.g. an external stakeholder proposal → ceiling `shareable`).
- An output **MUST exclude** content derived from sources whose (propagated)
  sensitivity exceeds the ceiling.
- The **Principal MAY override** surfacing per-output (e.g. writing a genuinely
  private note that *should* include candid opinions). Overrides are **logged/audited**.
- The original knowledge is **never lost** (Ground Truth Is Sacred) — it is withheld
  from the *output*, not removed from the KB.

## 6. Requirements

| ID        | Priority | Statement (short)                                                  | Verify   | Traces |
| --------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| SCOPE-1   | must     | Two-layer model: physical Instances + logical Scope/Sensitivity within an instance | none-yet | PRIN-19,20,21 |
| SCOPE-2   | must     | Instances are hard-isolated; no automatic cross-instance data flow; bridges are explicit Principal actions | none-yet | PRIN-19,20 |
| SCOPE-3   | must     | Scopes are user-defined; default `global`; an entity has one primary scope | none-yet | PRIN-5 |
| SCOPE-4   | must     | Scope is the unit agents/sources/tasks can be bound to (operational targeting) | none-yet | PRIN-20 |
| SCOPE-5   | must     | Links MAY cross scopes; cross-scope links are flagged; low-confidence ones route to Review | none-yet | PRIN-4; LIFE-6 |
| SCOPE-6   | should   | A query MAY be constrained to global, one scope, or a set of scopes | none-yet | VISION-9 |
| SCOPE-7   | must     | Sensitivity labels classify entities; default set ships; labels are data (custom supported) | none-yet | PRIN-19 |
| SCOPE-8   | must     | Default sensitivity on capture is conservative (`internal`) until classified | none-yet | PRIN-19 |
| SCOPE-9   | must     | Labels applied at ingestion on explicit/high-confidence signal; uncertain → Review; Principal override anytime | none-yet | PRIN-4; LIFE-6 |
| SCOPE-10  | must     | Derived artifacts inherit the most restrictive sensitivity of their sources by default | none-yet | PRIN-19 |
| SCOPE-11  | must     | Outputs declare audience/purpose → allowed sensitivity ceiling; outputs exclude content exceeding it | none-yet | PRIN-19 |
| SCOPE-12  | must     | Principal MAY override surfacing per output; overrides are logged/audited | none-yet | PRIN-5; LIFE-9 |
| SCOPE-13  | should   | Scope, Tag, and Sensitivity are kept distinct in model, prompts, UI, and code | none-yet | LANG-1 |
| SCOPE-14  | should   | Data connectors/sources carry default scope + sensitivity, applied to what they ingest (a high-confidence classification signal) | none-yet | PRIN-19; SCOPE-9 |

### SCOPE-10 — Sensitivity propagates through derivation
- **Status:** draft · **Priority:** must
- **Statement:** A derived artifact **MUST** inherit the **most restrictive**
  sensitivity among its source entities by default. The Principal **MAY** explicitly
  downgrade it.
- **Rationale:** Without propagation, sensitivity is "laundered" through summarization
  — an agent paraphrases a `confidential`/`private-opinion` source into a clean-looking
  new entity that escapes the surfacing filter. Propagation is the mechanism that makes
  SCOPE-11's guarantee actually hold.
- **Traces:** PRIN-1, PRIN-19, VISION-4
- **Verify:** none-yet

### SCOPE-11 — Surfacing policy gates outputs
- **Status:** draft · **Priority:** must
- **Statement:** Every derived output **MUST** declare an audience/purpose mapping to
  an allowed sensitivity ceiling, and **MUST** exclude content derived from sources
  whose propagated sensitivity exceeds that ceiling.
- **Rationale:** This is the direct fix for the "skeptical of Steve" and "Gary's
  embargoed project-cut" leaks — the output literally cannot include over-sensitive
  content unless the Principal overrides (SCOPE-12).
- **Traces:** PRIN-19, PRIN-6
- **Verify:** none-yet

## 7. Open questions

- [ ] **Audience/purpose taxonomy** — what's the concrete set of output audiences and
      each one's sensitivity ceiling? (self-private / internal-self / team / external-stakeholder?)
- [ ] **Multi-scope entities** — is one primary scope enough, or do some entities
      legitimately belong to several scopes at once? (Currently: one primary; links cross.)
- [ ] **Scope of an agent-derived entity** — when an agent derives from sources across
      scopes A and B, what scope does the new entity get? (Task's scope? multi? flagged?)
- [ ] **Sensitivity downgrade trust** — when the Principal downgrades a derived
      artifact, does that propagate to *its* descendants, and is it re-checked on Replay?
- [ ] **Instance discovery** — does the app know other instances exist (for explicit
      export UX), or is each instance fully unaware of the others?

## 8. Changelog

- 2026-06-07 — the **sensitivity** layer (SCOPE-7/8/9/10/14) is decomposed into an implementable feature
  spec, **SPEC-0043 (SENSE)** — labels + provenance, the gate **comparator**, ingestion-time classification
  (uncertain→Review), most-restrictive propagation, sticky Principal override, and consumer wiring to
  surfacing (SCOPE-11) + the researcher egress gate (SPEC-0028 D6/D8). Prioritized by the Principal as the
  track that "lights up" richer researcher orient reads. This product spec stays the *what/why*; SPEC-0043
  is the *how*. (Scope-layer requirements SCOPE-1..6/13 remain unimplemented, no feature spec yet.)
- 2026-05-30 — created (draft). Resolved Fork 1. Two-layer model (Instances +
  Scope/Sensitivity); `global` default scope; allow-but-flag cross-scope links;
  conservative default classification; **sensitivity propagation** (SCOPE-10);
  surfacing policy with Principal override (SCOPE-11/12); query-time scoping.
