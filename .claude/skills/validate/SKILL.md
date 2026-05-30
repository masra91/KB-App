---
name: validate
description: Run KB-App's local validation/test suite (typecheck, lint, unit tests, and e2e when present) and report a clear pass/fail. Use before committing, inside /mission, or whenever you need to confirm the app is green locally.
---

# /validate — local validation gate

Run the appropriate checks for KB-App and report an honest green/red. Fail fast and show
the failing output.

## Steps (from the repo root)
1. `cd app`
2. **Typecheck:** `npm run typecheck`
3. **Lint:** `npm run lint`
4. **Unit tests:** run `npm test` **if** a `test` script exists (Vitest).
5. **E2E:** run `npm run test:e2e` **if** it exists (Playwright, incl. the packaged-app
   boot smoke test that would have caught the `simple-git` packaging bug).

## Reporting rules
- Report each step's result. **Overall is green only if every present check passes.**
- If a test layer **does not exist yet**, say so explicitly — do **NOT** report green as
  though that layer were covered. A missing layer is a gap to surface (ENG-8/ENG-13).
- On failure, show the relevant output and stop.

## Notes
- Install/network commands may need the sandbox disabled.
- Honesty over green. Until the Testing Strategy spec lands the Vitest/Playwright harness,
  `/validate` = typecheck + lint, and it must say so.
