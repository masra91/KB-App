---
name: auto-mission
description: Like /mission, but authorized to take the work all the way through merge to main (not just open a PR). Use when the user wants autonomous end-to-end delivery of a story — "/auto-mission", "take this all the way", "land it yourself".
---

# /auto-mission — implement a story all the way to merged

Identical to **/mission**, but pre-authorized to complete the *entire* loop **through
merge** — you do not stop at "PR open."

## Flow
1. Run the full **/mission** workflow: orient → branch → implement against the spec →
   requirement-traced tests → `/validate` until green → `/kb-code-review` clean → open PR.
2. Then run **/merge** (squash-merge + delete branch) and sync `main`.

## Guardrails — do NOT skip (autonomy is earned by rigor)
- **Never merge on red:** `/validate` MUST be green and `/kb-code-review` MUST be clean
  (no blockers/majors) before `/merge`.
- Every `must` requirement implemented **and** tested (`Verify: → test:`).
- Spec synced in the same change (SPECSYS-7).
- If anything is ambiguous, or merging would violate an engineering principle, **STOP and
  ask** — never merge around uncertainty.
