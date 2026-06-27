---
spec: SPEC-0039
key: EXPLORE
title: Explore & Visualization (the knowledge, navigable)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0003, SPEC-0004, SPEC-0007, SPEC-0019, SPEC-0020, SPEC-0026, SPEC-0029, SPEC-0031, SPEC-0032, SPEC-0033]
stage: Explore
supersedes: null
---

# Explore & Visualization (the knowledge, navigable)

> An **in-app, read-only** surface to **navigate the evergreen knowledge graph** — start
> from an entity and walk its **typed, confidence-bearing relationships** to neighbors,
> click through to the readable entity page. The lifecycle's **Explore** stage (LIFE-5):
> examining knowledge *beyond a specific question*. v1 is sliced hard to a single,
> differentiated view — the **entity neighborhood** — not a global graph, not a timeline.

## 1. Intent (the why / JTBD)

Query (ASK, SPEC-0026) answers a *specific question*. **Explore is what you do when you
don't have one** — you have an entity (or a hunch) and you want to see what it connects to,
discover relationships you didn't know to ask about, and move through the graph by
association. JTBD: *"I'm looking at an entity — show me what it's related to, how, and how
strongly, and let me walk outward from there, landing on readable pages as I go."*

The knowledge already exists: Connect (SPEC-0020) promotes **typed entity↔entity links**
into the evergreen `entities/` graph (CONNECT-12/13, VAULT-12), each carrying a relationship
label and a **confidence** (DATA-8). Today the only way to *see* that graph is **Obsidian's
generic graph view** (VAULT/SPEC-0031) — which is optional, undifferentiated, and **blind to
the app's epistemic attributes** (it can't show that a link is speculative, or label the
relationship). Explore makes the graph a **first-class, in-app, app-identity** experience that
**stands alone without Obsidian** and shows what Obsidian can't.

Without it: the relationships Connect works to build are invisible unless the Principal
installs and opens Obsidian — and even then they read as anonymous undifferentiated edges.

## 2. Scope

**In scope (v1 — the thin slice):**
- A **read-only entity-neighborhood view**: a focused entity centered, its **directly-linked
  (1-hop) entities** around it, **typed + confidence-bearing edges**.
- **Focus + navigate**: enter by **search-to-focus** or **deep-link** from ASK / Review / an
  entity page; **re-center** on a neighbor by clicking it; **expand-in-place** a neighbor's
  own links; **click-through** to the full entity page (VAULT).
- **Bounded rendering** (focus + top-K neighbors, "+N more" overflow) and **filtering** (by
  edge type / entity kind), which together *are* the v1 perf strategy.
- A **distinct visual identity**, authored + gated via the design process (SPEC-0033),
  reusing the visual language VIZ (SPEC-0032) establishes.

**Out of scope (for now — see §6 Forks for the deferral rationale):**
- The **global / whole-graph** force-directed view (Obsidian covers this today; an in-app
  global graph is a v2 fork, and is where the *large-graph perf* problem actually lives).
- **Timeline** views (depend on temporal-metadata maturity on entities/events — v2).
- **Relationship maps / multi-entity comparison / saved views / bookmarks** (v2+).
- **Provenance / lineage edges** (source→entity, transform trail) — that is **AUDIT's** lane
  (SPEC-0029); Explore shows **semantic** entity↔entity links only.
- **Editing the KB through Explore** — it is strictly read-only; edits flow through
  capture / Review (mirrors VAULT §9).
- **The pipeline tracker** (sources moving through stages) — that is **VIZ** (SPEC-0032).

## 3. Boundaries — what Explore is *not*

Explore sits next to four adjacent surfaces; keeping the lines clean is most of this spec:

| Surface | Reads | Lens | Explore's relationship to it |
| --- | --- | --- | --- |
| **Obsidian graph** (VAULT, SPEC-0031) | `entities/` | generic, external, **optional** viewer | Explore is the **in-app, app-identity, epistemic-aware** counterpart that stands alone without Obsidian; same data, richer + native. **Not a replacement** — Obsidian stays the optional power-user global view. |
| **VIZ** (SPEC-0032) | OBS spans / pipeline state | **process** (sources moving through stages), transient | Different data, different lens. VIZ = *the machine working*; Explore = *the knowledge it built*. Explore **reuses VIZ's visual language**, not its data. |
| **ASK / Recall** (SPEC-0026) | `entities/` | a **specific question** → grounded answer | Composes: an ASK answer cites entities → "Explore around this" deep-links into the neighborhood view. ASK is targeted; Explore is open-ended. |
| **AUDIT / Activity** (SPEC-0029) | provenance / event log | **how** knowledge was derived (lineage) | Explore shows **semantic** relationships (entity↔entity), **not provenance** (source→entity). Provenance edges are AUDIT's; keeping them out is what keeps Explore legible. |

The throughline: **Explore reads the canonical evergreen `entities/` graph (SPEC-0019), is
read-only, and shows the semantic relationship structure — in the app, in the app's own
visual language.**

## 4. The v1 view & interaction

**The view — entity neighborhood:**
- A **focused entity** at the center: name, **kind** (tag-colored, per META/VAULT), confidence.
- Its **directly-linked entities** (1-hop) arranged around it.
- **Edges are labeled** with the relationship type and reflect **link confidence** —
  speculative/low-confidence links are visually distinct (DATA-8), not asserted as fact.
- **Bounded**: focus + **top-K neighbors** (ranked by confidence, then recency); a hub entity
  with many links shows a **"+N more"** overflow affordance rather than rendering hundreds.

**The interaction — focus + navigate:**
- **Enter** by (a) **search-to-focus** (type an entity name → land on its neighborhood), or
  (b) **deep-link** — arriving from an ASK answer, a Review item, or an entity page's "Explore"
  affordance.
- **Re-center** — click a neighbor → it becomes the new focus, its neighborhood loads;
  **breadcrumb / back** retraces the path.
- **Expand-in-place** — optionally reveal a neighbor's own links without changing focus
  (progressive disclosure).
- **Click-through** — open the full **entity page** (VAULT) for the readable claims + sources.
  *Exploration always leads back to reading.*
- **Filter** — narrow a dense neighborhood by **edge type** and/or **entity kind**.

## 5. User flows

**Primary — walk outward from an entity:**
1. From an ASK answer (or entity page, or search), open **Explore** focused on *"Q3 Budget"*.
2. See it centered with neighbors: *"Finance Team"* (owns, 0.9), *"Project Atlas"* (funds, 0.7),
   *"Steve Park"* (approver, 0.6, speculative — shown faded).
3. Click *"Project Atlas"* → it re-centers; its own neighbors load. Breadcrumb: Q3 Budget → Project Atlas.
4. Click-through *"Project Atlas"* → its full entity page (claims + sources) in VAULT.

**Secondary / edge:**
- **Hub entity** (50 links) → top-K shown, **"+12 more"** expands on demand; filter to `edge:owns` to thin it.
- **Sparse / no links** → focus renders as a **single node** with *"No relationships promoted yet"* and a one-line why (Connect hasn't linked this entity) — a clean empty state, not a blank canvas.
- **Reduced motion on** → re-center/expand transitions degrade to instant, no animated layout.

## 6. Forks — recommended resolutions

The PM named three forks (v1 view, interaction model, large-graph perf), plus the standing
LIFE open question (in-app vs Obsidian). Recommend-with-rationale on each:

### Fork 0 (meta) — In-app surface vs. delegate to Obsidian? *(LIFE open question)*
**Recommend: ship an in-app surface, scoped to what Obsidian can't do; keep Obsidian as the
optional global view.** Rationale: Obsidian is **optional** (VAULT-1) — the core product must
let the Principal explore relationships **without** it. And Obsidian's graph is **epistemically
blind** (no relationship labels, no confidence/speculative distinction) and is exactly the
**generic look** the app is moving away from (SPEC-0033). But we **don't** reimplement Obsidian's
global graph in v1 — we ship the **differentiated** slice (labeled, confidence-aware, navigable,
click-through-to-page) and leave the whole-graph view to Obsidian for now.

### Fork 1 — Which view ships v1: graph vs timeline vs neighborhood?
**Recommend: the entity *neighborhood* view (local graph). Defer global graph and timeline.**
Rationale:
- **vs global force-directed graph** — the global graph is (a) **what Obsidian already does**,
  (b) the **least differentiated**, and (c) where the **large-graph perf** problem lives.
  Neighborhood gives the core value (see relationships, walk them) at a fraction of the cost.
- **vs timeline** — genuinely differentiated (Obsidian can't), **but** depends on **temporal
  metadata maturity** on entities/events that isn't guaranteed today; building it v1 risks an
  empty view. Defer until the temporal data is real (named open question).
- **Neighborhood** is the **thinnest valuable slice**: it needs **no new data** (Connect's
  links already exist), composes with the core loop (ASK → Explore → entity page), and is the
  one view that is both *valuable* and *uniquely the app's*.

### Fork 2 — Interaction model?
**Recommend: focus + re-center navigation as primary; expand-in-place + click-through as
should; filter as should.** Rationale: re-centering keeps the rendered set **bounded and
predictable** (always one neighborhood), which is simple to build, simple to reason about, and
**doubles as the perf strategy**. Expand-in-place and filtering handle density without
unbounding the view. Click-through to the entity page keeps Explore honest about its job:
**navigation that leads back to reading**, not a destination that replaces the page.

### Fork 3 — Large-graph performance?
**Recommend: sidestep it in v1 by never rendering the global graph.** Rationale: with the
neighborhood model the render ceiling is **O(local neighborhood)** — focus + top-K (K bounded,
"+N more" overflow) — **not O(graph)**. There is no thousand-node force simulation to virtualize.
The real large-graph perf work (LOD, clustering, virtualization, incremental layout) is
**deferred *with* the global-graph view** it belongs to. v1's only perf obligations are: bound
the neighborhood, and keep re-center/expand interactions responsive.

## 7. Requirements

| ID         | Priority | Statement (short) | Verify | Traces |
| ---------- | -------- | ----------------- | ------ | ------ |
| EXPLORE-1  | must  | Explore is **strictly read-only** — it never mutates the KB; edits flow through capture/Review | none-yet | LIFE-5; VAULT §9 |
| EXPLORE-2  | must  | v1 ships the **entity-neighborhood view**: a focused entity centered with its directly-linked (1-hop) entities — **not** a global graph, **not** a timeline | none-yet | LIFE-5 |
| EXPLORE-3  | must  | Explore reads the **canonical evergreen `entities/` graph** (nodes = entities, edges = Connect-promoted entity↔entity links); it shows **nothing from working/staging state** | none-yet | DATA-3; CANON; CONNECT-3 |
| EXPLORE-4  | must  | Each node shows **identity at a glance** (name + kind, tag-colored) and is **click-through to the full entity page** (VAULT) — exploration leads back to reading | none-yet | DATA-6; VAULT-3; META |
| EXPLORE-5  | should | Each edge shows its **relationship type/label** and reflects **link confidence** — speculative/low-confidence links are **visually distinct**, not asserted (the Obsidian-can't differentiation) | explorePanel/View.test | DATA-8; CONNECT-12,13 |
| EXPLORE-6  | must  | **Focus + navigate**: enter via **search-to-focus** or **deep-link** (from ASK/Review/entity page); **re-center** on a clicked neighbor; **breadcrumb/back** retraces | none-yet | LIFE-5; ASK-7 |
| EXPLORE-7  | should | **Expand-in-place**: reveal a neighbor's own links without changing focus (progressive disclosure) | exploreView.test | LIFE-5 |
| EXPLORE-8  | should | **Bounded neighborhood**: render focus + **top-K neighbors** (ranked by confidence, then recency) with a **"+N more" overflow** affordance — no unbounded hub blow-up | none-yet | PRIN-5 |
| EXPLORE-9  | should | **Filter** the neighborhood by **edge type** and **entity kind** (optionally a confidence threshold) | exploreView.test | DATA-6,8 |
| EXPLORE-10 | must  | Explore has a **distinct, app-identity visual language** (reusing VIZ's), authored + gated via the design process (SPEC-0033, net-new visual → Design-Lead review) — not Obsidian's generic graph, not the generic AI look | none-yet | DESIGN-3,4; VIZ-8 |
| EXPLORE-11 | should | **Empty/sparse states** are clean: a focused entity with **no promoted links** renders as a single node + a plain-language "no relationships yet" (and why), never a blank/broken canvas | none-yet | PRIN-5; VAULT §10 |
| EXPLORE-12 | should | The view is **performant** by construction — it renders a **bounded local neighborhood, never the global graph**; re-center/expand stay responsive | none-yet | PRIN-5; VIZ-9 |
| EXPLORE-13 | should | **Reduced-motion** is honored — re-center/expand transitions degrade to instant per the design language's reduced-motion behavior | index.css @media reduce | DESIGN-5; VIZ-6 |
| EXPLORE-14 | may   | (v2) An **in-app global/whole-graph** view with real large-graph perf (LOD/clustering/virtualization) — *deferred; Obsidian covers the global graph today* | none-yet | LIFE-5 |
| EXPLORE-15 | may   | (v2) A **timeline** view over entities/events — *deferred pending temporal-metadata maturity* | none-yet | LIFE-5 |

## 8. Open questions

- [ ] **Entry surface** — is Explore a **dedicated nav view** (search-to-focus landing) **and**
      a deep-link target, or *only* launched-in-context from ASK/Review/entity pages? *(Lean:
      both — a nav view with search, plus deep-linkable.)*
- [ ] **Sparse-graph dependency/risk** — Connect's link-promotion has been observed **not
      firing** on rebuilds (VAULT §10 open question — *zero* entity↔entity links made). If the
      graph has few/no edges, Explore is mostly empty states. **Is link-promotion reliable enough
      for Explore to land, or does it gate v1?** *(Flag to KB-Lead — this is a real upstream
      dependency, not just a UI concern.)*
- [ ] **Edge direction & multiplicity** — are Connect's links directional (owns vs owned-by)?
      Render arrows, or undirected? How are multiple links between the same pair shown?
- [ ] **Top-K ranking** — confidence-then-recency? Or also weight by tag/topic affinity to the
      focus? And what's K (and the "+N more" expansion cap)?
- [ ] **Design timing** — Explore is a **net-new visual surface** (Design-Lead authors per
      SPEC-0033). Does it wait on **WS2 design-system primitives**, or get its own design pass?
- [ ] **Whole-graph: ever in-app?** — does the global graph eventually move in-app (EXPLORE-14),
      or stay Obsidian's job permanently? Decides how much of the perf problem we ever own.
- [ ] **Timeline data readiness** (EXPLORE-15) — what temporal metadata must mature on
      entities/events before a timeline view is buildable?

## 9. Changelog

- 2026-06-27 — **v1 FULL built** (Principal: ship all of v1) by KB-Developer-4, two slices:
  **slice 1 (#385)** — typed, confidence-bearing edges (EXPLORE-5): outgoing relationship
  predicates parsed from the center's links block + a **speculative** distinction below
  `EDGE_ASSERTED_AT` (0.7, per §5's worked example), rendered faded/brass with a non-color
  `~`-confidence a11y signal. **slice 2** — **filter** the loaded neighborhood by entity kind /
  edge type / hide-speculative (EXPLORE-9, instrument-language chips, no native select),
  **expand-in-place** a neighbor's own links without changing focus (EXPLORE-7, lazy-fetched +
  cached), with a reveal that degrades to instant under reduced-motion (EXPLORE-13). v1 bounds:
  per-edge confidence uses the neighbor node's confidence as the proxy (per-link confidence isn't
  persisted, DATA-8); incoming-edge predicates + hub-deep filtering beyond the loaded top-K are
  v2. Gates: Design-Lead visual + KB-Quality-Driver-2 code.
- 2026-06-06 — **renumbered SPEC-0037 → SPEC-0039** to deconflict a concurrent 4-way 0037 collision (WATCH/RICHIN/INTAKE also grabbed 0037 off a main that ended at 0036); allocation by ascending PR# posted on `control`. Key `EXPLORE` and all requirement IDs unchanged.
- 2026-06-06 — created (draft). Drafted by KB-Developer-4 on PM dispatch; → KB-Lead (product
  review) + KB-Quality-Driver-2 (spec gate-2). Defines the **Explore** stage's feature surface:
  an **in-app, read-only** view over the evergreen `entities/` graph. **v1 sliced hard to the
  entity-neighborhood view** (focus + navigate; typed, confidence-bearing edges; click-through to
  the entity page) — explicitly **not** the global graph (Obsidian covers it; it's where the
  large-graph perf problem lives) and **not** a timeline (deferred for temporal-data maturity).
  Recommend-with-rationale on all four forks (in-app-vs-Obsidian, v1 view, interaction, perf).
  Boundaries drawn vs Obsidian/VIZ/ASK/AUDIT. Central open risk flagged: Connect link-promotion
  reliability (sparse-graph → empty Explore).
