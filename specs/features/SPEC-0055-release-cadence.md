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

## 2. Pipeline (shape)
tag push (`v*`) → CI: checkout tagged SHA → install → **gate on green required checks** → Electron
Forge `package`/`make` (macOS) → **sign (Developer ID) → notarize → staple** → produce signed
`.dmg` + `.zip` + the updater manifest (`latest-mac.yml`) → **publish to GitHub Releases** (stable, or
pre-release for `-beta.N`). Secrets (Apple API key / Developer ID cert) live in CI secrets, never the
repo.

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`
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
- **RELEASE-9** (should) Release notes / changelog are attached to the GitHub Release (can be
  generated from commits/PRs since the last tag). `Verify: none-yet → test:`

## 4. Out of scope (v1)
- **Windows** signed builds + EV cert (later; keep the pipeline factored so Windows slots in).
- Linux packaging.
- App-store / DMG-background art (that's SPEC-0057 BRAND).
- The auto-update client (SPEC-0056).
