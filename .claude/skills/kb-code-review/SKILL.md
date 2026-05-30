---
name: kb-code-review
description: Review the current diff for correctness bugs, regressions, and compliance with KB-App's engineering principles (SPEC-0011) and specs. Use inside /mission before opening a PR, or any time you want a principled review of pending changes.
---

# /kb-code-review — principled review of the diff

Review the pending changes (default: `git diff` against the base branch; or a named PR).
Produce findings grouped by severity (**blocker / major / minor / nit**), each with
`file:line` and a concrete fix.

## What to check

### Correctness & regressions
- Logic errors, edge cases, error handling, async/await correctness, resource leaks.
- Does this break existing behavior? Is there a test guarding it?

### Engineering principles (SPEC-0011)
- **Dependencies (ENG-1..6):** any new/upgraded dep? Is it reputable, widely used,
  **≥7 days old**, **pinned**, peer-compatible, and justified vs. writing it ourselves?
- **Tests (ENG-7..14):** do new `must` requirements have tests that **trace to their IDs**?
  Coverage adequate (≥90% domain)? Does a bug fix include a regression test? Any test that
  asserts nothing real (padding)? Did `Verify:` graduate `none-yet → test:`?
- **Spec sync (SPECSYS-7):** was the relevant spec updated in this same change?

### Patterns & architecture
- Domain in `app/src/kb/` stays **shell-agnostic** (no electron/obsidian import).
- IPC stays on the typed contract; main process = manager (SPEC-0010).
- Simplicity (PRIN-5): unnecessary abstraction or complexity?

### Security & privacy (PRIN-19/20)
- No secrets/keys/tokens committed. No sensitive data leaked into logs or outputs;
  surfacing rules respected (SCOPE-11).
- Sources stay immutable; provenance preserved (DATA-*).

## Output
- Findings by severity, each with `file:line` + a concrete fix.
- End with a clear verdict: **ready to merge**, or **changes required** (list the
  blockers/majors that must be fixed first).
