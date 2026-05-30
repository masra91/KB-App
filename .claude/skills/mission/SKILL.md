---
name: mission
description: Implement a KB-App user story end-to-end — pick up the work, branch, implement against its spec, write requirement-traced tests, validate until green, self-review, and open a PR. Use when starting a feature/story, when the user says "/mission", "take this story", or hands you a unit of work to drive to a PR.
---

# /mission — implement a story to an open PR

The standard implementation loop for KB-App. **Invoking `/mission` authorizes the full
loop for *this* work**, including branch → commit → push → open PR (overriding the
default "don't push/commit unless asked").

## 0. Orient
- Read `CLAUDE.md` and the engineering rules (`specs/architecture/SPEC-0011`).
- Find the story's spec(s) in `specs/` (start at `INDEX.md`). **If no spec exists or its
  requirements are unclear, STOP and write/clarify the spec first** — requirements before
  code (ENG-7). List the `must` requirement IDs you must satisfy.

## 1. Branch
- If on `main`, create a feature branch: `git checkout -b <type>/<slug>`.

## 2. Implement
- Follow existing patterns: shell-agnostic domain in `app/src/kb/` (no electron/obsidian
  import), the typed IPC contract, main-process-as-manager (SPEC-0010).
- Honor engineering principles: dependency rules (ENG-1..6 — reputable, **≥7 days old**,
  **pinned**, peer-checked, justified) and simplicity (PRIN-5).
- Update the spec **in the same change** as behavior (SPECSYS-7): resolve open questions,
  add a changelog line.

## 3. Test (heavily — ENG E2)
- Write tests that **trace to requirement IDs**. Cover every `must` requirement.
- Aim very high coverage (≥90% on domain/core). Add a **regression test** for any bug found.
- Graduate each covered requirement's `Verify:` from `none-yet` → `test:<id-or-path>`.

## 4. Validate until green
- Run **`/validate`**. Fix and repeat until **all** checks pass. Never proceed on red.

## 5. Self-review
- Run **`/kb-code-review`** on the diff. Resolve bugs, regressions, and principle
  violations before opening the PR.

## 6. Open the PR
- Commit with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Push the branch; open a PR via `gh`.
- PR body: the story, **which requirement IDs are covered**, how it's tested, and any
  remaining open questions. End with the 🤖 Generated-with-Claude-Code footer.

## Done criteria (all required)
- Every `must` requirement implemented **and** tested (`Verify:` now `test:`).
- `/validate` green · `/kb-code-review` clean · spec synced · **PR open**.
