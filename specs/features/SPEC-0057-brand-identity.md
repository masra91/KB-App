---
spec: SPEC-0057
key: BRAND
title: Release Polish — Brand & Visual Identity
type: feature
status: draft
owners: [Principal, KB-Lead, Design-Lead]
related: [SPEC-0033, SPEC-0010, SPEC-0034, SPEC-0055]
created: 2026-06-27
stage: Cross-cutting
supersedes: null
---

# Release Polish — Brand & Visual Identity

> The product's name, mark, and finished surfaces — so a shipped, signed build (SPEC-0055) *feels*
> like a real product, not a dev tool. **Co-designed with the Principal**; this spec holds the
> structure + decisions and lists the asset slots; the identity itself is decided in §2 as we go.

## 1. Scope (the brand surfaces)
- **Name** — the product name + how it reads in UI, About, installer, repo.
- **Logomark / app icon** — the full macOS icon set (`.icns`, all sizes incl. retina), favicon-equivalents.
- **Color + type identity** — tied to the existing design-system tokens (SPEC-0033 WS2 `--viz-*`:
  warm cream / brass / ember / slate "instrument" language) — evolve it into a brand, don't start fresh
  unless we decide to.
- **App chrome** — window/titlebar treatment, About panel, empty-state art.
- **Distribution art** — DMG background + layout, installer presentation.
- **App metadata** — `productName`, bundle id (`com.<brand>.app`, ties SPEC-0034 signing), copyright.
- **Repo/landing visuals** — README header / simple landing (light touch).

## 2. Identity — RESOLVED (Principal, 2026-06-27): **Vellum**

- **Name:** **Vellum.** Tone: calm, scholarly — *a quiet, gilded study*; warm, not clinical.
- **Direction:** crystalline / fractal — knowledge as pattern & symmetry, *rendered as math, not
  foliage*; **fixed-light** "cream study" (surfaces don't invert).
- **Mark:** a self-similar **fractal lattice** — nested diamonds climbing to one luminous center node
  (the fragment that linked itself into structure). Detailed render at large sizes; **mono glyph
  ≤32px**. Same DNA at all sizes (icon = graph node = whole graph).
- **Palette:** Vellum cream `#F4EFE3` · **Viridian `#2F6B5B` (primary)** · Deep Blue `#1E3557` ·
  **Gilded Gold `#C9A35A` (rationed — lines/nodes/hairlines only)** · Sprout `#3E9E82` (in-progress) ·
  **Ember `#C8743C` (RESERVED — "needs your decision")** · Slate Ink `#2B2F36` (text). Signature
  gradient: deep-blue → slate → viridian → sprout.
- **Type:** **Spectral** (voice / serif) · **Inter** (interface, sentence case) · **IBM Plex Mono**
  (data: counts, confidence, hex, timestamps).

**Brand kit (canonical source, in repo):** [`brand/`](../../brand/) — `BRAND-GUIDELINES.md` (+ HTML
book), the icon set (SVG + PNG 16→1024 + mono glyph), wordmark/lockup, the fractal motif tile, the
palette board, and the winning mockups (*The Line* · *Explore*). **The kit is reference, not literal**
— adjust as the retheme proceeds. (Supersedes the earlier `specs/design/brand-pitches/` workshop
packets.) Retheme execution is gated on the prior-work-on-main checkpoint; then Design-Lead leads the
visual build (distinctiveness gate, SPEC-0033).

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`
- **BRAND-1** The app ships under a ratified **product name** applied consistently (window title, About,
  `productName`, bundle id, repo). `Verify: none-yet → test:`
- **BRAND-2** A complete **macOS app icon set** is present and wired (all required sizes/retina), shown
  in Dock/Finder/About. `Verify: none-yet → test:`
- **BRAND-3** Brand color + type **derive from / extend the design-system tokens** (SPEC-0033) — no
  off-system one-off palette; the app and its brand read as one thing. `Verify: none-yet → test:`
- **BRAND-4** An **About** surface shows name, mark, version (SPEC-0055 RELEASE-6), and credits.
  `Verify: none-yet → test:`
- **BRAND-5** **Distribution art** (DMG background/layout) presents the signed build cleanly on first
  open. `Verify: none-yet → test:`
- **BRAND-6** App **metadata** (bundle id, productName, copyright) is set for signing/notarization
  (SPEC-0034/0055). `Verify: none-yet → test:`
- **BRAND-7** (should) Empty/first-run states carry the brand (composes SETUP, SPEC-0009).
  `Verify: none-yet → test:`

## 4. Process
Co-design identity (§2) with the Principal → ratify (Design-Lead distinctiveness gate, SPEC-0033) →
produce the asset set → integrate (icons/metadata/About/DMG) → lands ahead of the first signed public
release (SPEC-0055). Visual decisions are the Principal's call with PO + Design-Lead input.

## 5. Out of scope
- Windows/Linux icon sets (with their packaging later).
- Full marketing site / app-store collateral.
