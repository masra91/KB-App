---
spec: SPEC-0055
key: RELEASE
title: Release Cadence & Signed Builds (tag-based, signed + notarized; macOS first)
type: feature
status: draft
owners: [Principal, KB-Lead]
related: [SPEC-0010, SPEC-0012, SPEC-0034, SPEC-0056]
created: 2026-06-27
stage: Cross-cutting
supersedes: null
---

# Release Cadence & Signed Builds

> Ship **official, signed, trustworthy builds** on a simple, predictable cadence: cut a release by
> pushing a version **tag**; CI builds, signs, notarizes, and publishes the artifact. macOS first;
> Windows later. Pairs with SPEC-0056 (auto-update) which consumes these releases.

## 1. Decisions (Principal, 2026-06-27)
- **Branching = tag-based on trunk.** `main` is always releasable; short-lived feature branches → PR
  → `main`. No develop/release/hotfix branches.
- **Versioning = semver.** Stable `vX.Y.Z`; **beta** pre-releases `vX.Y.Z-beta.N`.
- **Two channels = stable + beta.** A `-beta.N` tag publishes a **pre-release**; a clean `vX.Y.Z` tag
  publishes a **stable** release.
- **Trigger = the tag.** Pushing a matching version tag is the only thing that cuts a release —
  builds run off that exact tagged SHA, and only when CI on that SHA is green.
- **Signed + notarized, macOS first.** Developer ID Application signing + Apple notarization + staple,
  hardened runtime + entitlements (composes SPEC-0034 MACOS). Windows signing = later, out of v1.
- **Release authoring = a defined interactive flow + GPG-signed tags.** The Principal cuts a release
  through a checked-in `/release` flow that reviews the commits since the last tag, **classifies** each
  (feature / bug-fix / internal / hidden), **themes** them, writes the notes (human + updater-consumable),
  proposes the version, and creates a **GPG-signed** tag whose signature **CI verifies before building**.
  Prereq: the Principal's GPG signing key is configured (`user.signingkey`, `tag.gpgSign true`); CI holds
  the public key to verify. (Detailed in §3.)

## 2. Pipeline (shape)
tag push (`v*`) → CI: checkout tagged SHA → install → **gate on green required checks** → Electron
Forge `package`/`make` (macOS) → **sign (Developer ID) → notarize → staple** → produce signed
`.dmg` + `.zip` + the updater manifest (`latest-mac.yml`) → **publish to GitHub Releases** (stable, or
pre-release for `-beta.N`). Secrets (Apple API key / Developer ID cert) live in CI secrets, never the
repo.

## 3. The release-authoring flow (interactive, agent-driven)
Cutting a release is a **defined, interactive process**, not an ad-hoc tag. The Principal says *"I
want to cut a release"* and a checked-in `/release` flow drives it:

1. **Base** — find the last release tag for the target channel (last `vX.Y.Z` for stable; last
   `-beta.N` for beta).
2. **Collect** — gather every commit (squash-merged PRs) on `main` since that tag.
3. **Classify** — sort each change into one of four buckets, **seeded from its conventional-commit
   type** and confirmed interactively:

   | Bucket | Seeded from commit type | Shown to users? |
   |---|---|---|
   | **Feature** | `feat` | yes — itemized |
   | **Bug fix** | `fix` | yes — itemized |
   | **Internal** | `perf` · `refactor` · `chore` · internal `security` | yes — one brief "under the hood" line, not itemized |
   | **Hidden** | `docs` · `ci` · `test` · `style` · spec-only | omitted from user notes |

4. **Theme** — group the Features/Fixes into human themes (e.g. *Ingestion & performance · Researchers
   · Explore · Reliability*).
5. **Notes — two coupled outputs from one classification:**
   - **Human notes** — themed, grouped Markdown → the GitHub Release body **and** the app's "What's new".
   - **Updater notes** — a structured block (version, channel, date, themed feature/fix lists) that
     **electron-updater (SPEC-0056) surfaces in-app**.
6. **Version** — propose the semver bump from the change classes (breaking → major · any feature →
   minor · fixes-only → patch; beta → next `-beta.N`); the Principal confirms or overrides.
7. **Tag** — create a **GPG-signed annotated tag** at the release commit (`git tag -s vX.Y.Z`, the
   Principal's key). Pushing the signed tag is the trigger.
8. **Build & publish** — CI **verifies the tag's GPG signature**, then runs the §2 pipeline (build →
   sign → notarize → publish), attaching the human notes to the Release + the updater manifest.

The flow is **reproducible and reviewable**: the same defined steps every time, the Principal reviews
the classified notes before the tag is cut, and `CHANGELOG.md` is updated from the same data.

## 4. Requirements (must unless noted) — `Verify: none-yet → test:`
- **RELEASE-1** A release is cut **only** by pushing a semver tag; no other path publishes an official
  build. `Verify: none-yet → test:`
- **RELEASE-2** Tag grammar: stable = `vX.Y.Z`, beta = `vX.Y.Z-beta.N`; a beta tag publishes a GitHub
  **pre-release**, a stable tag a normal release. `Verify: none-yet → test:`
- **RELEASE-3** The build is produced from the **exact tagged SHA** and only when that SHA's required
  CI checks are green. `Verify: none-yet → test:`
- **RELEASE-4** macOS artifacts are **signed (Developer ID Application) + notarized + stapled** with
  hardened runtime; an unsigned/un-notarized artifact must never publish. `Verify: none-yet → test:`
  (verify: `codesign --verify --deep --strict` + `spctl -a` pass on the artifact)
- **RELEASE-5** The release publishes the **signed installer(s) + the updater manifest**
  (`latest-mac.yml`) needed by SPEC-0056. `Verify: none-yet → test:`
- **RELEASE-6** The app reports its **version** (matching the tag) at runtime (about/diagnostics) so a
  build is identifiable. `Verify: none-yet → test:`
- **RELEASE-7** Signing/notarization credentials live in **CI secrets**, never committed; the pipeline
  fails closed if they're absent. `Verify: none-yet → test:`
- **RELEASE-8** (should) The macOS package build runs on the per-PR cost-reduced path (SPEC-0012 /
  CI-COST) — the heavy signed build runs on **tag**, not every PR. `Verify: none-yet → test:`
- **RELEASE-9** (should) The GitHub Release carries **themed, classified release notes** generated by
  the §3 flow — not a raw commit dump. `Verify: none-yet → test:`
- **RELEASE-10** Release tags are **GPG-signed annotated tags** (`git tag -s`); CI **verifies the
  signature** before any build runs — an unsigned / invalid-signature tag does not release.
  `Verify: none-yet → test:`
- **RELEASE-11** Release notes are produced by **classifying every commit since the last tag** into
  feature / bug-fix / internal / hidden — seeded by conventional-commit type, confirmed in the
  interactive flow. `Verify: none-yet → test:`
- **RELEASE-12** The same classification emits **two coupled outputs** — human notes (Release body +
  in-app "What's new") **and** structured updater notes consumed by SPEC-0056. `Verify: none-yet → test:`
- **RELEASE-13** The flow **proposes the semver bump** from the change classes (major/minor/patch;
  beta `-beta.N`), Principal-confirmable. `Verify: none-yet → test:`
- **RELEASE-14** The release process is a **checked-in interactive flow** (a `/release` skill/runbook)
  — defined and reproducible, never ad-hoc. `Verify: none-yet → test:`
- **RELEASE-15** A repo **`CHANGELOG.md`** is maintained from the same release data (append per
  release; Keep-a-Changelog style). `Verify: none-yet → test:`
- **RELEASE-16** (should) **Conventional-commit prefixes are the classification substrate** — PR
  titles / squash commits follow `type(scope): …`, lint-enforced so the flow is reliable.
  `Verify: none-yet → test:`

## 5. Out of scope (v1)
- **Windows** signed builds + EV cert (later; keep the pipeline factored so Windows slots in).
- Linux packaging.
- App-store / DMG-background art (that's SPEC-0057 BRAND).
- The auto-update client (SPEC-0056).
