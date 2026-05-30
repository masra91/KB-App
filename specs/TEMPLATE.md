---
spec: SPEC-NNNN
key: SHORTKEY          # uppercase, stable, used for requirement IDs (e.g. CAPTURE-1)
title: <human title>
type: product          # product | feature | architecture | meta
status: draft          # draft | active | deprecated | superseded
owners: [KB-Architect]
created: 2026-MM-DD
updated: 2026-MM-DD
related: []            # other SPEC-NNNN this depends on / informs
supersedes: null
---

# <title>

> One-sentence summary of what this spec is about. If you can't write it in one
> sentence, the spec is doing too much — split it.

## 1. Intent (the why / JTBD)

What job does a user hire this for? What's the trigger, the desired outcome, the
payoff? What does the world look like *without* it? This is the most durable part
of the spec — write it for someone joining in a year.

## 2. Scope

**In scope:**
- ...

**Out of scope (for now):**
- ...

## 3. User flows / feature surface

Describe what the user experiences and does — step by step, plain language. Prefer
concrete walkthroughs over abstractions. Diagrams/sketches welcome.

**Primary flow — <name>:**
1. ...
2. ...

**Secondary / edge flows:**
- ...

## 4. Requirements

Normative, testable statements. Each gets a stable ID `<KEY>-N`, an RFC-2119
keyword, a priority, and a verification method. IDs are never reused.

| ID         | Priority | Statement (short) | Verify |
| ---------- | -------- | ----------------- | ------ |
| SHORTKEY-1 | must     | …                 | none-yet |

### SHORTKEY-1 — <short title>
- **Status:** draft
- **Priority:** must | should | may
- **Statement:** The system **MUST/SHOULD/MAY** …
- **Rationale:** why this matters / what breaks without it.
- **Verify:** none-yet  ·  *(later: `test:…`, `manual:…`, `ai-eval`)*

## 5. Open questions

Things we have not decided. First-class content — do not hide these.

- [ ] …

## 6. Changelog

- 2026-MM-DD — created (draft).
