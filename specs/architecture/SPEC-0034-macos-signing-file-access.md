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
**real fix** (MACOS-3..7) and the **release path** (MACOS-8).

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
- **Only notarized *distribution* is gated — on notarization *credentials*, not the cert.** DEV-2
  verified both `Apple Development` and `Developer ID Application` certs are already in the keychain;
  the missing piece is a `notarytool` credential profile. So all signing (dev + Developer ID) +
  the whole fix proceed **now**; only shipping a notarized build to users waits (MACOS-8).

## 4. Requirements

| ID       | Priority | Statement (short) | Verify | Traces |
| -------- | -------- | ----------------- | ------ | ------ |
| MACOS-1  | must     | **Interim mitigation (shipped):** first-run setup **detects** a vault path at/inside a TCC-protected location (`~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive — `detectTccProtectedDir`, darwin-only, dot-boundary-safe) and **warns + steers** the user to an unprotected folder, so the silent break is at least visible until the signed build lands | test:app/src/kb/vault.test.ts (detectTccProtectedDir); app/src/renderer.ts (setup warning) | STACK-10; SETUP-1; #56 |
| MACOS-2  | must     | On a **signed, entitled** build, a vault in a TCC-protected folder **ingests + enriches end-to-end** (capture → sources → entities/claims/wikilinks on `main`) with **no `Operation not permitted`** — the headline #56 acceptance | none-yet → test: packaged-app smoke + DEV-2 empirical run (§5) | STACK-10; DATA-9; #56 |
| MACOS-3  | must     | The packaged build is **code-signed with a STABLE identity** under the **hardened runtime** — `Apple Development` for dev/test, `Developer ID Application` for release — so the TCC grant persists across same-identity rebuilds. Ad-hoc `-` is insufficient: its designated requirement is a `cdhash` that changes every build → the grant re-prompts every rebuild (the STACK-10 root cause today — the shipped `.app` is `flags=0x2(adhoc)`). Configured in `forge.config.ts` `osxSign` (none today) | none-yet → test: `codesign -d --requirements -` yields an **identity-based DR** (not `cdhash`), **byte-identical across two consecutive packages** (DEV-2 verified §5) | STACK-10; STACK-2 |
| MACOS-4  | must     | The app is **explicitly NON-sandboxed** (hardened runtime, not App Sandbox). Chosen-folder access **persists** via the **TCC grant (by signature) + a regular `NSURL` bookmark** to re-resolve the vault path across launches — **not** security-scoped bookmarks, **not** the App-Sandbox `files.user-selected.read-write` entitlement | none-yet → test: relaunch re-resolves the bookmarked vault without re-prompting (signed build) | STACK-10 |
| MACOS-5  | must     | The folder grant **propagates to spawned `git`/`copilot` subprocesses** (the crux): a child tool's writes under the protected vault succeed (child inherits the parent's TCC grant). Carried by the stable signature + hardened-runtime entitlements (`com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`, `…disable-library-validation`) + the spawn method. **DEV-2 proved the mechanism** (§5): a parent spawning `git` into `~/Documents` succeeds; hardened-runtime library-validation blocks *loading* a bad dylib, not *spawning* a signed binary — so `Operation not permitted` is specifically the ad-hoc/unpersisted-grant case, not an inherent inheritance failure | none-yet → test: packaged smoke — a pipeline run (spawns git+copilot) writes into a granted `~/Documents` vault with **zero `Operation not permitted`** | STACK-10; ORCH-2; #56 |
| MACOS-6  | should   | The build declares **folder usage-description strings** (`NSDocumentsFolderUsageDescription`, `NSDesktopFolderUsageDescription`, `NSDownloadsFolderUsageDescription`) so the macOS TCC prompt explains *why* the app wants the folder (consent rationale) | none-yet → test: `Info.plist` inspection of the packaged build | STACK-10; PRIN-19 |
| MACOS-7  | must     | **First-launch permission-grant UX + denial fallback** (the #56 permission flow — **DEV-4's lane**). On first pipeline use against a protected folder the app's own **TCC prompt fires** once ("Allow access to Documents" — the one human-in-loop step, can't be headless); the surrounding UX makes clear *why* (ties to MACOS-6 rationale) and confirms when granted. **On denial** the app must **degrade visibly, never silently stall**: fall back to the MACOS-1 warn + **guide the user to System Settings → Privacy & Security → Files and Folders** (or to relocate the vault). *The exact denial-fallback posture (warn-and-steer vs deep-link to System Settings vs block-with-explainer) is a **product call routed to KB-Lead** (§8).* | none-yet → test: packaged manual check (prompt appears) + a unit test of the denial → warn/guide path | STACK-10; SETUP-1; PRIN-19; [#56](https://github.com/masra91/KB-App/issues/56) |
| MACOS-8  | must     | The **distribution** build is **Developer-ID-signed + notarized** (Gatekeeper/quarantine). **Reframed gate (DEV-2 verified):** NOT the cert — both `Apple Development` **and** `Developer ID Application` certs are in the keychain, so dev *and* Developer-ID signing work **now**; the only missing piece is **notarization credentials** (a `notarytool` `AC_PASSWORD`/App-Store-Connect API profile). So #56 is **signing-ungated; only notarized *distribution* is creds-gated** — release-only, not dev/test | none-yet (notarization-creds-gated) | STACK-10 |
| MACOS-9  | should   | A **documented dev-signing setup** (the `Apple Development` identity + the entitlements plist + the `osxSign`/`osxNotarize` Forge config) so any contributor reproduces the TCC persistence + subprocess-propagation test | none-yet → test: dev-setup doc + a scripted `codesign`/DR check | STACK-10; TEST-* |

## 5. Verification story (verified by running — DEV-2, macOS 26.5, real `codesign` + real `~/Documents`)

The load-bearing claims were settled **empirically before this spec locked** (KB-Eng "verify by
running"), not asserted. DEV-2's results (#56 thread):

- **Stable-identity ⟹ grant persistence (MACOS-3, PROVEN).** Signed with `Apple Development: Mason
  Allen` + `--options runtime` + the entitlements plist → designated requirement is **identity-based**
  (`anchor apple generic and certificate leaf[subject.CN] = "Apple Development: …"`). **Re-signing a
  fresh package yields a byte-identical DR** → a TCC grant keyed to it persists across rebuilds. The
  current shipped `.app` is **ad-hoc** (`flags=0x2(adhoc)`, DR = `cdhash`) → re-prompts every build:
  the STACK-10 root cause. **Acceptance:** `codesign -d --requirements -` is identity-based + stable
  across two packages.
- **Subprocess propagation (MACOS-5, PROVEN).** A parent spawning `git init/add/commit` into a
  `~/Documents` path **succeeded** — the child inherits the parent's grant; `git` (Apple-signed) and
  `copilot` (signed, team VEKTX9H2N7) spawn fine under hardened runtime (library validation gates
  *loading*, not *spawning*). **Acceptance:** with Documents access granted, a pipeline run writes into
  a `~/Documents` vault with no `Operation not permitted`.
- **Entitlements (used in the verified sign):** `com.apple.security.cs.allow-jit`,
  `…allow-unsigned-executable-memory`, `…disable-library-validation` + the Info.plist folder
  usage-description strings. Fix = add `osxSign` to `forge.config.ts` (none today).
- **Gate reframe:** the keychain has BOTH `Apple Development` and `Developer ID Application` certs →
  signing is **ungated now**; only **notarization credentials** (`notarytool` profile) are missing,
  so only notarized *distribution* is gated (MACOS-8).
- **Honest limit:** propagation was verified via a Full-Disk-Access session, not the packaged app's
  *own* first-launch TCC prompt (needs a human "Allow" click — can't be automated headlessly). That's
  expected one-time UX, captured as MACOS-7 (ensure the prompt fires + handle denial), not a blocker.

The **packaged-app smoke** (SPEC-0012 e2e tier) gains a protected-folder case so this can't silently
regress.

## 6. Scope split / ownership

- **KB-Developer-3** (author): this spec; the **subprocess-propagation + bookmark-resolve**
  requirements (MACOS-4/5) and their verification.
- **KB-Developer-2** (#25 signing/distribution): `forge.config.ts` `osxSign`, the hardened-runtime
  entitlements plist, the dev-identity + Developer-ID/notarization mechanics (MACOS-3/6/7), and the
  empirical run (§5).
- **KB-Developer-4** (the #56 permission UX): MACOS-7 — the first-launch grant flow + the
  denial-fallback surface (warn/steer + System-Settings guidance).
- **KB-Lead / Principal:** **notarization credentials** (a `notarytool` / App-Store-Connect API
  profile) — unblocks notarized *distribution* (MACOS-8) only. The signing certs are already present
  (DEV-2 verified), so nothing else waits on the Principal. Plus the two product calls in §8.

## 7. Out of scope (for now)

- Windows / Linux signing + their permission models (separate; this spec is macOS/TCC).
- App Sandbox + Mac App Store distribution (we are deliberately non-sandboxed — MACOS-4).
- Auto-update signing (later, with the distribution pipeline).

## 8. Open questions (product calls — routed to KB-Lead)

- [ ] **iCloud Drive scope.** Is iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs`) in
      **MACOS-2's end-to-end acceptance**, or **detect-warn-only** (MACOS-1)? Its TCC class **and**
      file-materialization model (on-demand download / evict) differ from Documents/Desktop/Downloads
      — a git repo on a partially-materialized iCloud tree is its own risk. Recommend **detect-warn
      only for v1** (steer off iCloud) unless KB-Lead wants the harder end-to-end guarantee.
- [ ] **Denial-fallback posture (MACOS-7).** When the user denies the TCC grant: warn-and-steer
      (MACOS-1 message), deep-link to System Settings → Privacy, or block-with-explainer? Product/UX
      call; DEV-4 implements once decided.

## 9. Changelog

- 2026-06-02 — **PM review additions.** Expanded **MACOS-7** into the full first-launch
  permission-grant UX + denial-fallback (DEV-4's lane); added **§8 open questions** routed to KB-Lead
  (iCloud-Drive in/out of MACOS-2 acceptance; the denial-fallback posture). PM scope ✓; awaiting
  KB-Lead product sign-off before lock.
- 2026-06-02 — **empirical verification folded in (DEV-2, macOS 26.5).** MACOS-3 + MACOS-5 are now
  evidence-based (§5): stable-identity DR persists across rebuilds (vs the current ad-hoc `cdhash` =
  the root cause); subprocess propagation proven (child git inherits the grant; hardened-runtime
  library-validation gates loading not spawning). Entitlements pinned (`cs.allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`). **Gate reframed:** both certs are
  in the keychain → signing is ungated *now*; only notarization **credentials** gate distribution
  (was mis-scoped as "paid cert"). Added MACOS-7 (first-launch prompt fires + graceful denial — the
  one human-in-loop step). Net: the fix proceeds now; only notarized release waits.
- 2026-06-02 — created (draft). Splits #56 / STACK-10 into a standalone spec: MACOS-1 (interim
  detect+warn) is **already shipped + tested** (`detectTccProtectedDir` + setup warning) and is
  graduated here; the real fix (MACOS-3..6 — stable-identity hardened-runtime signing, non-sandboxed
  TCC-grant + regular NSURL bookmark, subprocess grant-propagation) **proceeds now under a dev
  identity**; only release-signing (MACOS-7, Developer ID + notarization) is gated on the paid Apple
  cert. Incorporates DEV-2's #25 corrections: stable-not-ad-hoc identity, non-sandboxed (drop
  security-scoped bookmarks / sandbox entitlement), subprocess propagation is the crux. DEV-2 to
  empirically verify MACOS-2/5 (§5).
