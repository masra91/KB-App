# Vellum — Dark Mode Addendum

Companion to `BRAND-GUIDELINES.md`. **Dark mode only** — everything else (mark, type,
voice, motif, motion, rationed gold, reserved ember) is unchanged.

## Thesis
Dark mode is **not an inversion**. It's the **night study** — the app icon's own world
(deep blue-green ground) expanded to fill the canvas. **Cream stops being the canvas and
becomes the INK.** Gold and ember are unchanged; they simply glow harder on dark. **Light
stays the default brand face; dark is the supported night variant.**

## Dark tokens (override the light values)
| Token | Dark value |
|---|---|
| Canvas / background | `#15242E` |
| Surface | `#1E3340` |
| Raised / active | `#243843` |
| Sidebar gradient | `#192933` → `#16242D` |
| Window border | `#2C4150` |
| Hairline / dividers | `#2E4350` |
| Body backdrop gradient | `#15252F` → `#0D1820` |
| Graph canvas (vignette) | radial `#1C3441` (center) → `#11202A` (edge) |
| Text / ink | `#ECE4D2` (parchment — cream is now the ink) |
| Secondary text | `#93A39E` |
| Primary brand (lifted) | `#4E9E86` (Viridian) |
| Active (lifted) | `#5BC09C` (Sprout) |
| Mid blue (lifted) | `#5E93B4` |
| Accent | gold `#C9A35A`; edges/icons `#D8B569`; light `#E6CE86` |
| Needs-decision (RESERVED) | `#C8743C` (Ember — unchanged) |

## Node-type colors (dark)
| Type | Dark | (light was) |
|---|---|---|
| Person | `#4E86A8` | `#1E3557` |
| Concept | `#46A98A` | `#2F6B5B` |
| Document | `#5E93B4` | `#3A6E88` |
| Claim | `#C9A35A` | unchanged |

## Center graph node (dark)
Inner disc `#1E4A39` (light was `#23553F`). Keep the rest: outer glow ring `#FBF7EC` @ ~0.35
+ gold ring `#C9A35A`, inner lattice stroke `#E6CE86`, center dot `#FBF7EC`.

## Component notes (dark)
- **Graph edges:** lift to `#D8B569` so they glow on the dark ground.
- **Confidence pills:** dark fill `#15242E`, gold stroke `#C9A35A`, numerals `#E6CE86`.
- **Node / center labels:** parchment `#ECE4D2`. "CONCEPT"-type captions: `#5BC09C`.
- **Legend dots:** match the dark node-type colors above.
- **Field / watermark opacity:** raise (~0.16) so the faint fractal field reads on dark.

## Rules
- **Only the CANVAS changes character.** Everything else is the same brand, lights down.
- **Gold stays RATIONED** — discipline is *stricter* here, because gold pops more on dark.
  Lines / nodes / hairlines / one highlight per view only; never gold fills or gold body text.
- **Ember stays RESERVED** for "needs your decision."
- **Default skin = LIGHT** (icon, marketing, first-run). **Dark = night variant, never the identity.**
- Respect `prefers-reduced-motion` as in light mode.
