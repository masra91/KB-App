---
design: DESIGN-MACOS-PERMISSION
implements: SPEC-0034
title: macOS Folder-Permission UX — Visual Design ("Asking for the keys")
type: design
status: draft
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-06-02
updated: 2026-06-02
related: [SPEC-0034, SPEC-0033, SPEC-0009, SPEC-0017]
design-system: pipeline-visualization.md   # reuses "The Line" shared _design-system (DESIGN-7)
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector (distinctiveness)
  qa-flow-coverage: pending # GATE 2 — KB-Quality-Driver (all key flows)
stage: First-run
---

# macOS Folder-Permission UX — Visual Design ("Asking for the keys")

> A **small** SPEC-0033 surface (MACOS-2/6/7). KB-App's vault often lives in a macOS-protected
> location (Documents / Desktop / iCloud Drive); the app needs TCC permission to read+write it.
> macOS shows its **own, non-restylable** system dialog — so this design is the **in-app framing
> around it**: a pre-prompt that explains *why* before the OS asks, and a non-dead-end **recovery**
> when access is denied. Built on the shared `_design-system` ("The Line") for one coherent app.
> Implements the **ruled behavior** (KB-Lead, relayed via PM): *on deny → warn + steer to System
> Settings → Privacy; iCloud → detect-warn-only (v1)*. (SPEC-0034 is the parent, finalizing under
> #159; this expresses the locked behavior.)

## 1. The constraint (what we can and can't style)

The actual grant is macOS's **TCC system dialog** — we cannot restyle or pre-empt it; it fires on
the app's **first protected-folder access** (the first spawned-git write into the vault, MACOS-5).
So the design owns the **two moments we *do* control**, in our own visual language:

1. **Pre-prompt** — set context *before* the OS dialog, so the system ask isn't a cold surprise
   (raises confident grants, cuts accidental denials).
2. **Denied-state recovery** — a clear, actionable in-app state if access is blocked, steering to
   the exact Settings pane. **Never a dead end.**

Plus a non-blocking **iCloud detect-warn** (v1).

## 2. The flows / states

```
FIRST-RUN, vault is in a protected location
        │
        ▼
┌─ PRE-PROMPT (in-app, our voice) ───────────────────────────────┐
│ ⌖  KB-App needs access to your vault folder                     │
│    To read and write your notes in                              │
│    ~/Documents/MyVault, macOS will ask next — choose **Allow**. │
│                                              [ Continue ]       │   → triggers the OS TCC dialog
└────────────────────────────────────────────────────────────────┘
        │
        ├── Allowed ──▶ proceed silently (no celebration UI — it just works)
        │
        └── Denied / dismissed ──▶
┌─ BLOCKED (in-app recovery — brass, actionable) ────────────────┐
│ ⚠  KB-App can't reach your vault folder                         │
│    Access to ~/Documents/MyVault is turned off, so your notes   │
│    can't be read or written until you allow it.                 │
│                                                                 │
│    To fix: System Settings → Privacy & Security →               │
│    Files and Folders → enable **KB-App**.                       │
│                          [ Open System Settings ]   [ Retry ]   │
└────────────────────────────────────────────────────────────────┘

iCloud vault detected (any time) → a quiet inline note, non-blocking:
│ ☁ Your vault is in iCloud Drive — files may sync/evict; KB-App reads them on demand. │
```

- **Pre-prompt** — a single calm panel in the app's voice: *what* it needs, *which exact folder*
  (the resolved path, mono), and *that macOS will ask next*. One primary action **Continue** that
  triggers the OS dialog. No scare language; this is routine setup.
- **Blocked / denied** — **brass, actionable** (waiting on *you*, not a crash): names the blocked
  folder, states the consequence plainly, and gives the **exact Settings path** + a primary
  **Open System Settings** button that deep-links straight to the Privacy pane
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_Files...`), plus **Retry**
  (re-attempts after the user grants, so they don't relaunch). Actionable recovery, never a dead end.
- **iCloud detect-warn (v1)** — a quiet, **non-blocking** inline note when the vault is under iCloud
  Drive (sync/eviction nuance). Detect + warn only — no gating in v1.

## 3. Visual language (reused from "The Line" `_design-system`)

No new language — this is app chrome, so it must read as **the same instrument**, not a generic OS
permission modal:
- **Tokens / type / primitives** from the shared `design-system.css`: graphite field, `--viz-ink`
  body, signage for the heading, flat-ink **no card chrome** (a ruled panel, not a floating
  shadowed modal), `--viz-ember` focus rings, the resolved **path in mono** (`--viz-numeric`).
- **State color (per the system's semantics):** the **blocked state is `--viz-brass`** — *waiting
  on your action* (grant access), **not `--viz-oxide`** (oxide is reserved for the *broken* alarm;
  a not-yet-granted permission is expected setup, not a failure). The iCloud note is `--viz-ink-muted`
  (quiet info). The pre-prompt is neutral graphite/ink. State is never color-alone — each carries a
  glyph (`⌖` ask / `⚠` blocked / `☁` iCloud).
- **Motion:** effectively none (this isn't a live surface) — panels appear instantly; reduced-motion
  is a no-op. Calm.

### Anti-generic-AI (GATE 1 / DESIGN-3)
| Generic tell | What we do |
| --- | --- |
| A centered card-with-shadow modal, indigo "Allow" button | A flat **ruled panel** in the app surface, ember focus, no card chrome |
| Generic "Enable permissions to continue" with a spinner | Names the **exact folder** (mono) + **exact Settings path**, our voice |
| Dead-end "Permission denied" toast | A **brass, actionable** recovery: deep-link to Settings + Retry |
| Scary red error for a denied permission | **Brass** (needs-you action), not oxide — it's setup, not a crash |

## 4. Key flows covered (GATE 2 — KB-Quality-Driver)

| # | Flow (MACOS-2/6/7) | How the design serves it |
| --- | --- | --- |
| 1 | First-run, protected vault → user understands + grants | **Pre-prompt** explains why + which folder before the OS dialog; **Continue** triggers it |
| 2 | User **allows** | Proceeds silently — no needless confirmation UI |
| 3 | User **denies / dismisses** → can recover | **Blocked** state: exact Settings path + **Open System Settings** deep-link + **Retry** (the ruled deny→steer-to-Settings behavior) |
| 4 | Vault in **iCloud Drive** | Non-blocking **detect-warn** note (v1 scope) |

## 5. Out of scope (v1)
- Restyling the macOS TCC dialog (impossible — system-owned).
- iCloud eviction *handling* / Full-Disk-Access automation — v1 is **detect-warn-only**.
- Notarization / signing UX (MACOS-8, release/creds gate).
- Non-macOS permission models.

## 6. Decisions (rationale → `decisions`)
- **Pre-prompt before the OS dialog** — the system ask is terse + cold; our framing raises confident
  grants and cuts accidental denials (the #56 silent-break class).
- **Denied = brass (needs-you), not oxide (broken)** — coheres with the system semantic (oxide is the
  *broken* alarm; a denied permission is expected setup the user resolves), and keeps it from reading
  as a crash.
- **Deep-link + Retry, never a dead end** — the ruled "steer to Settings → Privacy" made actionable.

## 7. Changelog
- 2026-06-02 — created (draft). Small SPEC-0034 (MACOS-2/6/7) surface: an in-app **pre-prompt**
  (explain before the OS TCC dialog) + a **brass, actionable denied-state recovery** (exact Settings
  path + Open-System-Settings deep-link + Retry) + a non-blocking **iCloud detect-warn** (v1). Reuses
  "The Line" `_design-system` (DESIGN-7); blocked = brass (needs-you), not oxide (broken). Expresses
  KB-Lead's ruled behavior; SPEC-0034 parent finalizing under #159. Pending GATE 1 + GATE 2.
