---
name: validate
description: Run KB-App's local validation/test suite (typecheck, lint, unit tests) and report a clear pass/fail. Use before committing, inside /mission, or whenever you need to confirm the app is green locally. e2e is CI-only (SPEC-0012 TEST-9), not part of local validate.
---

# /validate — local validation gate

Run the appropriate checks for KB-App and report an honest green/red. Fail fast and show
the failing output.

## Steps (from the repo root)
1. `cd app`
2. **Typecheck:** `npm run typecheck`
3. **Lint:** `npm run lint`
4. **Unit tests:** run `npm test` (Vitest). Use `npm run test:coverage` when you want the
   coverage gate (≥90% on `src/kb`, TEST-12) as well.
5. **E2E is deliberately NOT part of local validate (SPEC-0012 TEST-9).** The local quick
   suite is fast: typecheck + lint + unit only. Playwright e2e (the packaged-app boot smoke
   that would have caught the `simple-git` packaging bug) runs in **CI only** — do **not**
   run `npm run test:e2e` here. That's a layer CI owns, not a gap to report.

## Reporting rules
- Report each step's result. **Overall is green only if every present check passes.**
- If a test layer **does not exist yet**, say so explicitly — do **NOT** report green as
  though that layer were covered. A missing layer is a gap to surface (ENG-8/ENG-13).
- On failure, show the relevant output and stop.

## Notes
- Install/network commands may need the sandbox disabled.
- Honesty over green. The Testing Strategy spec (SPEC-0012) landed the Vitest harness, so
  `/validate` = typecheck + lint + unit. e2e is CI-only and not counted here.
