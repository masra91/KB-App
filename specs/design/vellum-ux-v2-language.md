# Vellum UX v2 — design language (Principal-approved direction)

> The ground-up UX rethink. The MVP shipped as an accent-theme over a deliberately **flat, "no card
> chrome," 34rem single-column** instrument language — which is why it read as a cramped dev tool.
> This is the approved replacement: warm, crafted depth + calm motion + real polish. Reference
> prototype: [`design-prototypes/vellum-ux-v2.html`](../../design-prototypes/vellum-ux-v2.html) (open
> in a browser; nav between **Today** and **Explore**). Evolves SPEC-0057 / `brand/`. **Reference, not
> literal** — the prototype is the language, not the final screens.

**Status:** direction approved by the Principal (2026-06-27) on the prototype's two surfaces. Pairs with
**SPEC-0058** (UI State Model) — the projections are shaped from these screens inward (STATE-13). Per-view
rollout lands on top of each surface's projection. Gate-of-record: a **live packaged-app walkthrough**
(every view, light + dark), signed by Design-Lead **and** QA — static CSS audits are no longer sufficient.

## The seven moves

1. **Depth & material.** A systematic 3-level elevation scale (page → card → floating): a warm inner
   top-light (`rgba(255,255,255,.7) inset`) + a long, *cool, blue-tinted* shadow (`rgba(20,40,55,…)`),
   over a faint vellum paper-grain. Depth — not borders — is what kills the flat feel. (This reverses the
   old `.viz-no-chrome` "no shadows" rule for surfaces; the flat instrument primitives can stay where
   they read as ruled structure, but containers gain material.)
2. **Motion — present but calm.** Ambient drift on fractal fields (40–50s), a gold thread that flows
   along The Line, active pipeline stations *breathe*, the decision cue pulses ember. **No blink.**
   Respect `prefers-reduced-motion`. (Principal cut the breathing ring on the Explore center node — the
   center stays static.)
3. **Hover & life.** Cards lift + shadow-bloom + a gold radial sheen; graph nodes grow and light their
   incident edges gold; nav items indent + gild their icon; buttons press. Everything reacts.
4. **Color discipline (the rule the ship violated).** Cream/linen ground · viridian primary · gold
   **rationed** (icons + one highlight per view) · **ember ONLY for "needs your decision"** · oxide for
   true error · sprout for in-progress · slate-blue for interactive. Errors must be oxide, never
   burnt-orange/ember.
5. **Type & voice.** Spectral (headings / synthesis) · Inter (UI, sentence case) · IBM Plex Mono (all
   data / numbers). Warm, scholarly copy ("Good evening. Your library is quiet and current.").
6. **Layout & responsiveness.** Drop the 34rem single-column straitjacket — fluid, multi-region layouts
   that breathe and reflow (the rail/sidebar collapse at narrow widths). The window reads like a desktop
   product, not a phone card.
7. **IA.** Nav regrouped: *do* (Today · Capture · Ask · Explore) → *Pipeline* (The Line · Reviews ·
   Activity · Health) → *Manage* (Agents · Sources · Settings). **"Today" is a new command-center home**
   the app lacked.

## Shell language
Rounded window card; gradient sidebar with the Vellum wordmark + fractal glyph at the top, grouped nav,
gold active-accent (inset bar + linen gradient, not a solid blue fill), a faint fractal watermark; an
ambient textured cream ground (radial light from top-left + grain). The content region is wide and
airy with generous padding, Spectral section heads.
