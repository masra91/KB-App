---
spec: SPEC-0056
key: UPDATE
title: In-app Auto-Update (electron-updater via GitHub Releases; stable + beta)
type: feature
status: draft
owners: [Principal, KB-Lead]
related: [SPEC-0055, SPEC-0010, SPEC-0034, SPEC-0027]
created: 2026-06-27
stage: Cross-cutting
supersedes: null
---

# In-app Auto-Update

> The app keeps itself current: checks for a newer signed release, downloads in the background, and
> installs on restart — without the Principal re-downloading by hand. Consumes the releases produced
> by SPEC-0055.

## 1. Decisions (Principal, 2026-06-27)
- **Mechanism = `electron-updater` with the GitHub provider** — reads **GitHub Releases**
  (`latest-mac.yml` + the signed artifact). Zero extra infra; the repo is public; integrates directly
  with the SPEC-0055 tag cadence. (Azure-blob + JSON-manifest considered and deferred — revisit only
  if we outgrow GitHub Releases.)
- **Channels = stable + beta**, matching SPEC-0055. Stable installs follow stable releases; opting
  into **beta** also receives `-beta.N` pre-releases.

## 2. Behavior (shape)
On launch + on an interval, the updater checks the GitHub Releases feed for the app's channel. A
newer version → download in the background → notify the Principal → **install on quit/restart**.
A manual **"Check for updates"** is available. macOS update install uses Squirrel.Mac, which
**verifies the code signature** of the downloaded build before applying — so only a properly
signed (SPEC-0055) update can install.

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`
- **UPDATE-1** The app checks GitHub Releases for a newer version (on launch + periodic) and can
  download + apply it, installing on restart. `Verify: none-yet → test:`
- **UPDATE-2** **Channel-aware:** a stable install only offers stable releases; a beta opt-in also
  offers `-beta.N` pre-releases. The channel is a user setting (Control Panel, SPEC-0027).
  `Verify: none-yet → test:`
- **UPDATE-3** **Signature-verified install:** an update only applies if its code signature is valid
  (Squirrel.Mac / Developer ID from SPEC-0055); a tampered/unsigned package is refused.
  `Verify: none-yet → test:`
- **UPDATE-4** Updates are pulled **only from the official repo's GitHub Releases** (pinned
  owner/repo), never an arbitrary URL. `Verify: none-yet → test:`
- **UPDATE-5** A manual **"Check for updates"** action exists, and auto-check is a respected setting
  (can be turned off). `Verify: none-yet → test:`
- **UPDATE-6** Update activity is observable (current version, available version, download/error
  state) — surfaced honestly, no silent failures. `Verify: none-yet → test:`
- **UPDATE-7** (should) A failed/partial download is recoverable (retry; never bricks the installed
  app). `Verify: none-yet → test:`
- **UPDATE-8** Any new dependency (`electron-updater`) is reputable, pinned, ≥7-day-aged (E1).
  `Verify: none-yet → test:`

## 4. Out of scope (v1)
- Azure-blob/manifest delivery (deferred; keep the provider swappable if we revisit).
- Delta/differential updates.
- Windows update flow (lands with Windows signing, SPEC-0055 follow-up).
- Staged/percentage rollouts.
