---
spec: SPEC-0036
key: CONTRA
title: Contradiction Lifecycle
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-03
updated: 2026-06-03
related: [SPEC-0016, SPEC-0018, SPEC-0019, SPEC-0020, SPEC-0024, SPEC-0026, SPEC-0029]
stage: Review
supersedes: null
---

# Contradiction Lifecycle

> When two sources assert **conflicting facts** about the same entity, the KB should **track the
> disagreement** through an explicit lifecycle to resolution — not silently hold both and assert one
> at recall time. A contradiction is a **first-class object** linking the conflicting claims, moving
> through a small **state machine** (`detected → resolved / accepted / needs-you`) that rides
> entirely on substrate we already have: per-claim epistemics (CLAIMS), the Review queue (SPEC-0018),
> deletion-aware promotion (SPEC-0019), and the audit log (SPEC-0029).

## 1. Intent (the why / JTBD)

A grounded second brain inevitably ingests sources that disagree — a bio that says "born 1815" and
another "born 1816"; a spec that says one thing and a newer revision that reverses it. Today we do
the safe-but-passive thing: record **both** claims with their own provenance (CLAIMS-17) and leave
"conflict surfacing" deferred. That means recall can confidently assert a fact the KB *itself* holds
contradicting evidence for. JTBD: *"when my sources disagree, tell me — track it, resolve it when
the evidence is clear, and when it's a real judgment call, ask me; and when I recall it, show me
it's contested, don't bluff."*

This is **not** a pipeline stage — it's a **lifecycle over the canonical state**. A contradiction is
a long-lived object that's *detected*, may *wait* on a human, and reaches a terminal state; it can
re-open if new evidence lands. It belongs to the same family as Review items, set-aside items, and
research escalations — all of which surface in the unified **needs-you queue** (#192).

## 2. The state machine

```
                  newer / stronger-provenance claim supersedes
                  (loser RETAINED + marked, never deleted)
detected ───────────────────────────────────────────────► resolved   (terminal)
   │
   ├──► accepted    both legitimately stand, kept WITH ATTRIBUTION      (terminal)
   │                (e.g. genuine historical disagreement)
   │
   └──► needs-you   a real conflict the machine won't auto-judge        (waiting)
                    → Review queue (#192) → human picks → resolved/accepted

  (re-open) any terminal contradiction re-opens to `detected` if a NEW conflicting
            claim about the same fact lands later.
```

- **detected** — agent judgment (over a bounded set, no embeddings) finds ≥2 claims about one
  entity asserting incompatible facts.
- **resolved** — a newer or stronger-provenance claim **supersedes**; the superseded claim is
  **retained and marked** (we never destroy source-grounded testimony).
- **accepted** — both stand, attributed (the "both true per their source" case).
- **needs-you** — routed to **Review** (SPEC-0018) — the unified needs-you surface doing exactly its
  job; the human chooses supersede (→resolved) or accept-both (→accepted).

## 3. Requirements

| ID       | Priority | Statement (short) | Verify | Traces |
| -------- | -------- | ----------------- | ------ | ------ |
| CONTRA-1 | must | A **contradiction is a first-class tracked object** linking ≥2 conflicting claims about **one entity**, with its lifecycle state and the *why*; stored append-only alongside the claims it references (CLAIMS-11 posture — never mutates the source/identity) | none-yet | CLAIMS-7,11,17; DATA-10 |
| CONTRA-2 | must | Contradictions are **detected by agent judgment** over a **bounded working set** — **no embeddings/preprocessing** — reusing REFLECT's detection model (a REFLECT finding type), and at Claims-time when a new claim conflicts with an existing one about the same entity | none-yet | SPEC-0024 REFLECT-3; CLAIMS-7 |
| CONTRA-3 | must | The lifecycle is the **state machine** of §2: `detected → resolved \| accepted \| needs-you`, with **re-open** on new conflicting evidence; every transition is **append-only audited** | none-yet | AUDIT-2; ORCH-11 |
| CONTRA-4 | must | **Resolution never destroys source-grounded testimony**: a superseded claim is **retained + marked** (not deleted); state changes publish via the gate, deletion-aware only for genuine retraction the human approves | none-yet | CLAIMS-17; CANON-1,3; STAGING |
| CONTRA-5 | must | **Auto/Review split (guarded posture):** a **high-confidence supersession** (clear newer/stronger provenance) may **auto-resolve**; **genuine conflicts and all low-confidence cases route to the #192 needs-you queue** — never silently auto-picked | none-yet | AUTO-1,3,10; SPEC-0018; REFLECT-5 |
| CONTRA-6 | must | **Recall surfaces contested facts**: when answering touches a fact under an open (or accepted) contradiction, recall **flags it as disputed** and cites **both** sources rather than asserting one | none-yet | SPEC-0026 ASK-7; PRIN-2 |
| CONTRA-7 | should | A resolved/accepted contradiction is **visible** in the entity's view (a quiet "contested → resolved/accepted" note), and open ones surface in **Status + the needs-you queue** | none-yet | SPEC-0031 VAULT; SPEC-0030 OBS; SPEC-0032 VIZ-7 |

## 4. Key user flows / surface

- Two sources give different birth years → Claims/REFLECT **detects** a contradiction → high-confidence
  supersession (a primary, recent source) **auto-resolves**, the older claim retained + marked.
- A genuine conflict with no clear winner → **needs-you queue** ("Person X: source A says ⟨…⟩, source
  B says ⟨…⟩ — supersede or keep both?") → you pick → resolved/accepted.
- You **recall** that fact → the answer says *"sources disagree here"* and cites both — never a
  confident single answer over contested evidence.

## 5. Out of scope (for now)

- **Detecting** which claims conflict *mechanically* (embeddings/NLI) — v1 is agent-judgment only.
- **Cross-entity** contradictions (a conflict spanning a typed link/relation) — single-entity v1;
  relational conflicts defer to CONNECT/typed-links.
- **Auto-retraction** (deleting a claim) — v1 retains both; deletion only via human-approved Review.

## 6. Open questions

- [ ] **"Same fact" granularity** — how tightly must two claims be about *the same assertion* to
      count as a contradiction (vs. merely related)? (Tune via the detection instruction.)
- [ ] **Supersession confidence bar** — what provenance/recency signal is "strong enough" to
      auto-resolve vs. route to needs-you?
- [ ] **Storage shape** — contradiction object as its own file (`contradictions/`) vs. a marker on
      the involved claims + an audit record. (Architecture.)
- [ ] **Accepted → recall** — exactly how recall renders an *accepted* (both-stand) contradiction vs.
      an *open* one.

## 7. Changelog

- 2026-06-03 — created (draft). The **contradiction lifecycle**: a first-class tracked object over
  conflicting claims, moving `detected → resolved/accepted/needs-you` (re-openable), agent-detected,
  guarded auto/Review split into the **#192 needs-you queue**, never destroying source testimony, and
  surfaced as **contested** at recall. Rides on existing substrate (CLAIMS epistemics + Review + audit
  + promotion). From the Principal's knowledge-health capability review.
