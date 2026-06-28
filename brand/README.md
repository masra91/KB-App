# Vellum — Brand Kit (v1)

A concept pass at the Vellum identity: a calm, scholarly "second brain" for markdown
notes. Synthesized from our direction — converged palette, crystalline, not botanical
fractal motif, self-similar mark, rationed gold, dialed-down foliage.

## Start here
- **`brand-guidelines.html`** — the brand book. Open in any browser. The best overview.
- **`BRAND-GUIDELINES.md`** — the same rules in plain text.

## What's inside
```
vellum-brand-kit/
├─ brand-guidelines.html        the brand book (open this)
├─ BRAND-GUIDELINES.md          plain-text rules
├─ mockups/
│  ├─ the-line.html             live screen — the pipeline ("The Line")
│  ├─ explore.html              live screen — the knowledge graph ("Explore")
│  ├─ the-line.png              rendered preview
│  └─ explore.png               rendered preview
└─ assets/
   ├─ icon/
   │  ├─ vellum-icon.svg        hero app icon (vector)
   │  ├─ vellum-glyph-mono.svg  menu-bar glyph (template, single color)
   │  └─ png/                   vellum-icon-{1024..16}.png + mono-36
   ├─ logo/
   │  ├─ vellum-lockup.svg      mark + wordmark
   │  └─ vellum-wordmark.svg    wordmark only
   ├─ motif/fractal-lattice.svg the fractal motif tile
   └─ palette/vellum-palette.svg swatch board
```

## Notes
- The mockups and brand book are fully self-contained (icons are inline SVG; only Google
  Fonts load over the web). Open the HTML files directly — no build step.
- Icons in the app screens are stand-in line glyphs for layout; swap for your final icon set.
- **Before shipping:** outline the wordmark text to paths (so it renders without the font),
  and redraw the app icon as clean production vector. Use the mono glyph at ≤32px.

Palette, type, and rules are in the brand book. Fonts: Spectral (voice), Inter (UI),
IBM Plex Mono (data).
