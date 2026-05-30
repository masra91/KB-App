---
name: merge
description: Squash-merge a pull request into main and delete its branch. Works on ANY PR (by number/URL/branch), not just the current branch or your own — supports multi-agent flows where the merger isn't the author. Use when the user says "/merge", "merge that PR", "land PR #N", "squash and merge".
---

# /merge — squash-merge a PR and delete its branch

KB-App's standard landing pattern: **squash-merge + delete branch**. One clean commit per
PR on `main`; the PR retains the granular commits. Works on **any** PR — the operator need
not be the author or have the branch checked out (multi-agent: implementer ≠ tester ≠ merger).

## Input
- A PR reference if given: a number (`42` / `#42`), a URL, or a branch name.
- If none is given, target the PR for the **current branch**.

## Steps
1. Resolve the PR: `gh pr view <ref>` (or current branch). Confirm it targets `main`.
2. Sanity-check it's landable: `gh pr checks <ref>` (CI green) and its review state. Do
   **not** merge a failing/unreviewed PR unless the Principal explicitly overrides.
3. **Squash-merge and delete** the branch (remote, and local if present):
   `gh pr merge <ref> --squash --delete-branch`
4. If you're working in a clone of the repo, sync `main`: `git checkout main && git pull`.
5. Verify: `gh pr view <ref>` shows merged; `git log --oneline -3` on `main`.

## Rules
- **Squash always** — exactly one clean commit per PR on `main`.
- **Delete the branch** after merge (remote, and local if it exists here).
- Only merge a **green** PR (CI + `/kb-code-review` passed) unless the Principal overrides.
- You do **not** need to be the author or have the branch checked out.
- If `main` doesn't yet exist on the remote, push it first (`git push origin main`).
