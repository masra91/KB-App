---
spec: SPEC-0034
key: MACOS
title: macOS Signing, Entitlements & File Access (TCC-protected vaults)
type: architecture
status: draft
owners: [KB-Developer-3, KB-Developer-2, KB-Lead]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0010, SPEC-0014, SPEC-0009, SPEC-0021]
stage: Cross-cutting
supersedes: null
---

# macOS Signing, Entitlements & File Access (TCC-protected vaults)

> Make the app **work when the vault lives where users actually keep notes** — `~/Documents`,
> `~/Desktop`, `~/Downloads`, iCloud Drive — all of which macOS gates behind **TCC** (Transparency,
> Consent & Control). Today a vault in one of these **silently breaks the pipeline**: the folder
> picker grants the *Electron app* access, but an unsigned/ad-hoc build doesn't hold that grant or
> propagate it to the spawned `git`/`copilot` subprocesses, so their writes fail with `Operation not
> permitted` and the inbox never drains — invisibly (issue #56). This spec details how STACK-10 (the
> `must`) is met: a **stably code-signed, hardened-runtime, non-sandboxed** build whose TCC grant
> reaches its child processes.

## 1. Intent (the why / JTBD)

A second brain that breaks when pointed at `~/Documents` is not shippable — that's where a large
share of users keep notes. JTBD: *"point the app at any folder I choose, including a macOS-protected
one, and have ingestion → enrichment work end-to-end with no silent permission failures."*

The failure is **invisible** (the packaged app swallows subprocess stderr — SPEC-0030 OBS exists
because of exactly this class of silent stall), so the bar is not just "works" but "works **or** tells
the user why not." The interim detect-and-warn (MACOS-1) already ships; this spec is mostly about the
**real fix** (MACOS-3..6) and the **release path** (MACOS-7).

## 2. Root cause (grounded, not theorized)

From #56's repro + DEV-2's signing analysis (#25 area):

- The Open-folder picker grants **the app** TCC access to the chosen folder. But TCC keys that grant
  off the app's **code-signing designated requirement**. An **ad-hoc** signature (`-`, the Forge
  default today — `forge.config.ts` has no `osxSign`) has **no stable identity**: its cdhash changes
  every rebuild, so the grant doesn't persist and one wrongly concludes "TCC doesn't persist."
- Worse, the access must reach the **spawned `git`/`copilot` subprocesses**. TCC attributes file
  access to the **responsible process** (our app); whether a child binary inherits it depends on the
  signature, the **hardened-runtime entitlements**, and how we spawn. This **subprocess propagation
  is the crux** — bookmark persistence is the easy half.
- **Not an App Sandbox problem.** Security-scoped bookmarks + `com.apple.security.files.user-selected.read-write`
  are *App Sandbox* APIs. We are **non-sandboxed** (we spawn arbitrary subprocesses and touch
  user-chosen folders — sandboxing those is impractical). The persistence primitive is therefore the
  **TCC grant (by signature)** plus a **regular `NSURL` bookmark** to re-resolve the path across
  launches — explicitly *not* security-scoped bookmarks.

## 3. Approach

- **Sign with a stable identity + hardened runtime.** `forge.config.ts` gains `osxSign`: a stable
  **local dev identity** for development/test (so the TCC grant persists across same-identity
  rebuilds — the testable path, no paid cert), swapped to a **Developer ID** for release. Hardened
  runtime on, with the entitlements that let our spawned tools keep file access.
- **Non-sandboxed.** Pinned explicitly. Persistence = TCC-grant-by-signature + a regular NSURL
  bookmark of the chosen vault path.
- **Verify subprocess propagation by running** (not by theory): a dev-signed hardened-runtime package,
  a vault in `~/Documents`, the pipeline run end-to-end, confirming `git`/`copilot` writes succeed and
  the grant survives a same-identity rebuild (DEV-2's macOS BYOA env).
- **Interim warn already ships** (MACOS-1) and stays as the graceful fallback for any
  not-yet-granted / unsigned-dev case.
- **Release-signing (Developer ID + notarization) is the only piece gated on the paid Apple cert**;
  everything above proceeds now under the dev identity.

## 4. Requirements

| ID       | Priority | Statement (short) | Verify | Traces |
| -------- | -------- | ----------------- | ------ | ------ |
| MACOS-1  | must     | **Interim mitigation (shipped):** first-run setup **detects** a vault path at/inside a TCC-protected location (`~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive — `detectTccProtectedDir`, darwin-only, dot-boundary-safe) and **warns + steers** the user to an unprotected folder, so the silent break is at least visible until the signed build lands | test:app/src/kb/vault.test.ts (detectTccProtectedDir); app/src/renderer.ts (setup warning) | STACK-10; SETUP-1; #56 |
| MACOS-2  | must     | On a **signed, entitled** build, a vault in a TCC-protected folder **ingests + enriches end-to-end** (capture → sources → entities/claims/wikilinks on `main`) with **no `Operation not permitted`** — the headline #56 acceptance | none-yet → test: packaged-app smoke + DEV-2 empirical run (§5) | STACK-10; DATA-9; #56 |
| MACOS-3  | must     | The packaged build is **code-signed with a STABLE identity** under the **hardened runtime** — a **local dev identity** for dev/test (the TCC grant must persist across same-identity rebuilds; ad-hoc `-` is insufficient — unstable cdhash), a **Developer ID** for release. Configured in `forge.config.ts` `osxSign` | none-yet → test: `codesign --verify`/`--display` on the packaged `.app` + persistence check (§5) | STACK-10; STACK-2 |
| MACOS-4  | must     | The app is **explicitly NON-sandboxed** (hardened runtime, not App Sandbox). Chosen-folder access **persists** via the **TCC grant (by signature) + a regular `NSURL` bookmark** to re-resolve the vault path across launches — **not** security-scoped bookmarks, **not** the App-Sandbox `files.user-selected.read-write` entitlement | none-yet → test: relaunch re-resolves the bookmarked vault without re-prompting (signed build) | STACK-10 |
| MACOS-5  | must     | The folder grant **propagates to spawned `git`/`copilot` subprocesses** (the crux): a child tool's writes under the protected vault succeed. Carried by the signature + hardened-runtime entitlements (e.g. `com.apple.security.cs.disable-library-validation`) + the spawn method (responsible-process = our app) | none-yet → test: DEV-2 empirical subprocess-write run (§5) + packaged smoke | STACK-10; ORCH-2; #56 |
| MACOS-6  | should   | The build declares **folder usage-description strings** (`NSDocumentsFolderUsageDescription`, `NSDesktopFolderUsageDescription`, `NSDownloadsFolderUsageDescription`) so the macOS TCC prompt explains *why* the app wants the folder (consent rationale) | none-yet → test: `Info.plist` inspection of the packaged build | STACK-10; PRIN-19 |
| MACOS-7  | must     | The **distribution** build is **Developer-ID-signed + notarized** (Gatekeeper/quarantine) — **gated on the paid Apple Developer certificate**; the dev-signature path (MACOS-3..5) proceeds without it, so this gate blocks *release only*, not development/test | none-yet (cert-gated) | STACK-10; this is the only #56 piece truly blocked |
| MACOS-8  | should   | A **documented stable local dev identity** (create-once self-signed cert in the keychain + the `osxSign` identity name) so any contributor can reproduce the TCC persistence + subprocess-propagation test without the paid cert | none-yet → test: dev-setup doc + a scripted check | STACK-10; TEST-* |

## 5. Verification story (verify by running)

The load-bearing claims (MACOS-2/5) are settled **empirically**, not asserted (KB-Eng "verify by
running"):

1. Create a **stable local dev signing identity** (self-signed, in the keychain).
2. `forge.config.ts` `osxSign` → that identity + hardened-runtime entitlements plist.
3. Package the `.app`; place a vault in `~/Documents/<x>`; run capture → confirm the pipeline drains:
   `git`/`copilot` subprocess **writes succeed**, sources/entities/claims/wikilinks land on `main`,
   **zero `Operation not permitted`**.
4. **Rebuild** with the same identity, relaunch → the TCC grant + NSURL bookmark **persist** (no
   re-prompt, still works) — proving the stable-identity requirement (MACOS-3).
5. (DEV-2, macOS BYOA env) runs 1–4 to de-risk the design before implementation locks; the result
   feeds MACOS-2/5's `Verify` + the final entitlements list.

The **packaged-app smoke** (SPEC-0012 e2e tier) gains a protected-folder case so this can't silently
regress.

## 6. Scope split / ownership

- **KB-Developer-3** (author): this spec; the **subprocess-propagation + bookmark-resolve**
  requirements (MACOS-4/5) and their verification.
- **KB-Developer-2** (#25 signing/distribution): `forge.config.ts` `osxSign`, the hardened-runtime
  entitlements plist, the dev-identity + Developer-ID/notarization mechanics (MACOS-3/6/7), and the
  empirical run (§5).
- **KB-Lead / Principal:** the paid Apple Developer certificate (unblocks MACOS-7 / release only).

## 7. Out of scope (for now)

- Windows / Linux signing + their permission models (separate; this spec is macOS/TCC).
- App Sandbox + Mac App Store distribution (we are deliberately non-sandboxed — MACOS-4).
- Auto-update signing (later, with the distribution pipeline).

## 8. Changelog

- 2026-06-02 — created (draft). Splits #56 / STACK-10 into a standalone spec: MACOS-1 (interim
  detect+warn) is **already shipped + tested** (`detectTccProtectedDir` + setup warning) and is
  graduated here; the real fix (MACOS-3..6 — stable-identity hardened-runtime signing, non-sandboxed
  TCC-grant + regular NSURL bookmark, subprocess grant-propagation) **proceeds now under a dev
  identity**; only release-signing (MACOS-7, Developer ID + notarization) is gated on the paid Apple
  cert. Incorporates DEV-2's #25 corrections: stable-not-ad-hoc identity, non-sandboxed (drop
  security-scoped bookmarks / sandbox entitlement), subprocess propagation is the crux. DEV-2 to
  empirically verify MACOS-2/5 (§5).
