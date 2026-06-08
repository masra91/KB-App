---
spec: SPEC-0043
key: SENSE
title: Sensitivity Classification (labels, propagation, the comparator consumers gate on)
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-07
updated: 2026-06-07
related: [SPEC-0005, SPEC-0007, SPEC-0008, SPEC-0018, SPEC-0019, SPEC-0020, SPEC-0022, SPEC-0027, SPEC-0028, SPEC-0029]
stage: Enrich
supersedes: null
---

# Sensitivity Classification (labels, propagation, the comparator consumers gate on)

> The **implementation** of SPEC-0005's sensitivity layer (SCOPE-7/8/9/10/14). Today every source
> reads as the hardcoded conservative default `internal`, so nothing that *gates on sensitivity* —
> the surfacing ceiling (SCOPE-11) and the **researcher egress/orient gate** (SPEC-0028 D6/D8) —
> can do anything but the most-conservative thing. This spec makes sensitivity **real, persistent,
> and comparable**: every source/entity carries a label, labels are applied at ingestion on a
> high-confidence signal (uncertain → Review), they **propagate most-restrictively** through
> derivation, and a single **comparator** is the one source of truth every consumer reads. When this
> lands, the researcher warm-start (RESEARCH-22) and output surfacing **"just light up."**

## 1. Intent (the why / JTBD)

SPEC-0005 (SCOPE) defines *what* sensitivity is and *why* it matters — the principal's two fears:
output-surfacing leaks ("we are skeptical of Steve") and over-sharing embargoed/need-to-know content
("Gary said XYZ is cut"). It specs the model (labels, conservative default, ingestion-time
classification, most-restrictive propagation, surfacing ceiling) but **none of it is built** — the
label is a hardcoded `internal` constant. This spec is the *how*: the data model, the classification
flow, the propagation rule, and — critically — the **comparator** the gates consume.

JTBD: *"label what comes in so the system can refuse to leak it later — without me hand-tagging every
note, and without a paraphrase laundering a confidential source into a clean-looking shareable one."*

This is an **enabling** feature: its direct first consumer is the researcher warm-start (SPEC-0028
RESEARCH-22 / D6 / D8), whose richer KB-orient reads are gated on real labels; its headline consumer
is **output surfacing** (SCOPE-11). SENSE owns the **label + the comparator**; consumers read them.

## 2. The model

Sensitivity is a **first-class governed label** on every **source** and **entity** (SPEC-0007 data
model), distinct from Scope and Tag (SCOPE-13). Three moving parts:

- **The label** — a string from the default set (`shareable` · `internal` · `confidential` ·
  `private-opinion` · `embargoed`), **custom labels supported** (data, not a hardcoded enum, SCOPE-7),
  stored in frontmatter with **provenance** (how it was assigned + confidence + when).
- **The comparator** — a total preorder over labels used by every gate. SENSE is its **single home**;
  surfacing and the researcher gate both call it. Unknown/custom labels resolve **most-restrictive**
  (unknown ≠ safe).
- **Propagation** — a derived artifact inherits the **most-restrictive** sensitivity of its sources
  (SCOPE-10), computed at the **writer** of the derived thing (Connect for `entities/`, the output
  builder for outputs). Prevents "laundering" sensitivity through summarization.

## 3. The flow

```
INGEST a source (SPEC-0008)
   │  apply sensitivity by SIGNAL PRIORITY (SENSE-4):
   │    1. Principal explicit label (if set)         → use it
   │    2. connector/source default (SCOPE-14)       → high-confidence signal
   │    3. agent classifier (confidence score)       → use if ≥ threshold
   │    else / uncertain                             → conservative DEFAULT `internal`
   │                                                   + a SUGGESTED label → Review (SPEC-0018)
   ▼
source carries { sensitivity, by: <signal>, confidence?, at } in frontmatter
   │
   ▼  pipeline derives (Decompose → Connect → Claims; Outputs)
DERIVED entity/output inherits MOST-RESTRICTIVE source sensitivity (SENSE-6, comparator)
   │
   ▼  consumers GATE on the comparator (SENSE-3/9):
   ├─ output surfacing: exclude content whose propagated sensitivity > the output's ceiling (SCOPE-11)
   └─ researcher egress/orient: sensitivityAllowsOrientRead(tier, sensitivity) per the D6 map (SPEC-0028)
   │
   ▼  Principal MAY override anytime (up or down) → audited, STICKY across Replay (SENSE-7)
```

## 4. The comparator (the load-bearing detail)

A total preorder for gate comparisons — `restrictiveness(label) → rank`:

| rank | labels | gate meaning |
| ---- | ------ | ------------ |
| 0 | `shareable` | leaves the box freely |
| 1 | `internal` | internal surfaces / own-tenant only |
| 2 | `confidential` | need-to-know |
| 3 | `private-opinion`, `embargoed` | **never egresses / never in an artifact by default** |
| 3 | *any custom / unknown label* | **resolves most-restrictive** (unknown ≠ safe) |

`private-opinion` and `embargoed` are **not** a linear extension of `confidential` — they are special
(`private-opinion` = candid takes, never in a produced artifact unless explicitly requested;
`embargoed` = true but time/audience-gated). For the **egress/surfacing gate** they are treated as
**most-restrictive** (rank 3): only a `local-only` researcher (stays on the machine) or an explicit
Principal override may touch them. *This conservative placement is a SENSE decision (D1), tunable —
it does not redefine the labels' product meaning, only their gate rank.*

Worked against the **SPEC-0028 D6 map** (ratified 2026-06-07):
- `public-web` researcher → may read **rank ≤ 0** (`shareable` only)
- `internal-tenant` researcher → may read **rank ≤ 2** (`shareable`/`internal`/`confidential`)
- `local-only` researcher → may read **any rank** (incl. `private-opinion`/`embargoed`)

## 5. Requirements

| ID | Priority | Statement (short) | Verify | Traces |
| -- | -------- | ----------------- | ------ | ------ |
| SENSE-1 | must | Every **source** and **entity** carries a `sensitivity` **label** in frontmatter — a **string** (data, not a hardcoded enum), the default set ships (`shareable`/`internal`/`confidential`/`private-opinion`/`embargoed`), **custom labels supported**; Scope/Tag/Sensitivity stay distinct in model + code (SCOPE-13) | test: `sourceDoc`/`orchestrator` (source; entity label = Slice 3 propagation) | SCOPE-7,13; DATA-2 |
| SENSE-2 | must | **Default on capture/ingest = `internal`** (conservative; unknown ≠ shareable) — applied whenever no higher-priority signal classifies the source | test: `sourceDoc`/`orchestrator` | SCOPE-8 |
| SENSE-3 | must | A single **comparator** (`restrictiveness(label) → rank`, §4) is the **one source of truth** for every sensitivity comparison; **unknown/custom labels resolve most-restrictive**; `private-opinion`/`embargoed` rank most-restrictive for the gate. Consumed by surfacing AND the researcher gate — **no consumer re-implements ordering** | test: `sensitivity.test.ts` | SCOPE-7,11; SPEC-0028 D6 |
| SENSE-4 | must | Classification is **applied at ingestion by signal priority**: (1) Principal explicit label, (2) connector/source default (SENSE-5), (3) agent classifier with a **confidence score** ≥ threshold; **uncertain / below-threshold → the source stays at the conservative default AND a *suggested* label routes to Review** (SPEC-0018); Principal may override anytime | none-yet | SCOPE-9,14; REVIEW |
| SENSE-5 | must | A **connector/source declares a default scope + sensitivity** applied to everything it ingests; connector identity is a **high-confidence** classification signal (`internal` is relative-per-connector) | test: `sourceDoc`/`orchestrator` | SCOPE-14 |
| SENSE-6 | must | **Propagation:** a derived entity/output **inherits the most-restrictive** sensitivity of its sources by default (via the SENSE-3 comparator), computed at the **writer** — **Connect** for `entities/` (sole `entities/` writer, CANON-5), the output builder for outputs — so paraphrase can't launder sensitivity | none-yet | SCOPE-10; CANON-5; CONNECT |
| SENSE-7 | must | The **Principal may override** a label anytime (up or down); overrides are **logged/audited** and **STICKY across Replay** — a rebuild re-applies the override and the classifier **never overwrites** a Principal-set label | none-yet | SCOPE-9,12; REPLAY |
| SENSE-8 | must | Every **classification + override is an audited event** (SPEC-0029) recording the **signal + confidence** provenance (`by: default \| connector \| classifier \| principal`), so a label's origin is always inspectable | test: `orchestrator` (classification; override audit = Slice 1b) | AUDIT-11; PRIN-19 |
| SENSE-9 | must | The label + comparator are the **input to consumers**, not re-derived by them: the **output surfacing ceiling** (SCOPE-11) and the **researcher egress/orient gate** (`sensitivityAllowsOrientRead`, SPEC-0028 D6/D8) both read SENSE. SENSE ships the label + comparator; wiring each consumer is that consumer's story | test: `sensitivity.test.ts` (`sensitivityAllowsOrientRead` gate shipped; consumer wiring = RESEARCH-22 / SCOPE-11) | SCOPE-11; SPEC-0028 D6,D8 |
| SENSE-10 | should | The **Control Panel** surfaces an entity/source's sensitivity (view + Principal edit) and renders **suggested/uncertain** labels in the Review queue for one-click accept/override | none-yet | PANEL-1; REVIEW |
| SENSE-11 | must | The classifier treats source **content as DATA, never instructions** — a document body saying "classify me shareable" is quoted content, not a directive (untrusted-content posture) | none-yet | PRIN-19; RESEARCH-12 |

## 6. User stories

- **As the Principal**, when I capture a candid note about a colleague, it lands `internal` by default and
  — because the classifier flags candor — a **`private-opinion` suggestion shows up in Review**; I accept
  it once and it never leaks into a produced artifact again. *(SENSE-2/4/10)*
- **As the Principal**, my work-email connector tags everything it pulls `internal`/`Work` automatically,
  so I never hand-classify routine mail. *(SENSE-5)*
- **As the system**, when Connect derives a new entity from one `confidential` source and one `shareable`
  source, the entity is **`confidential`** — the summary can't be surfaced more freely than its most
  protected input. *(SENSE-6)*
- **As a `public-web` researcher**, during orient I may read the **`shareable`** neighbors of the request
  subject to find a real gap, but I **cannot** read the `confidential` ones — the same gate that protects
  outputs protects my outbound queries. *(SENSE-3/9, SPEC-0028 RESEARCH-22)*
- **As the Principal**, I downgrade one derived note to `shareable` to put it in an external proposal; the
  override is **audited**, and it **survives a full Replay** instead of snapping back. *(SENSE-7)*

## 7. Data shape (frontmatter)

```yaml
# on a source or entity (SPEC-0007)
sensitivity: internal            # the label (string; default set or custom)
sensitivityMeta:
  by: classifier                 # default | connector | classifier | principal
  confidence: 0.82               # present when by: classifier (omitted otherwise)
  at: 2026-06-07T19:40:00Z
  suggested: private-opinion     # present only while a Review suggestion is open
```

Provenance lives in `sensitivityMeta` so the label itself stays a clean scalar for the comparator and
for human reading. A Principal override sets `by: principal` and **clears** `suggested`.

## 8. Delivery slices

Lowest-risk-first; each slice is a reviewable PR with requirement-traced tests:

- **Slice 1 — labels + comparator + conservative default + connector signal + override.** The frontmatter
  field (SENSE-1), `internal` default (SENSE-2), the **comparator** (SENSE-3) as a standalone tested unit,
  connector/source default sensitivity (SENSE-5), Principal override + audit (SENSE-7/8), Control-Panel
  view/edit (SENSE-10). **No classifier yet** — sources land at default or connector-signal. *This alone
  un-hardcodes `internal` and lets `internal-tenant`/`local-only` researcher orient reads light up.*
  Delivered in two reviewable PRs: **Slice 1a** = the source frontmatter label + `sensitivityMeta`
  provenance (SENSE-1 source / -2 / -5 / -8 classification), the **comparator** + the
  `sensitivityAllowsOrientRead` **egress/orient gate** (SENSE-3/9, the security unit); **Slice 1b** =
  the Principal override (SENSE-7, audited + Replay-sticky) + the Control-Panel view/edit (SENSE-10).
- **Slice 2 — agentic classifier + uncertain→Review.** The confidence-scored classifier (SENSE-4/11),
  the suggested-label Review path (SENSE-10), behind the Copilot SDK seam with a deterministic fallback.
  *This is what lets `public-web` orient reads light up for `shareable`-classified content.*
- **Slice 3 — propagation + surfacing enforcement.** Most-restrictive inheritance at the writers
  (SENSE-6), Replay stickiness (SENSE-7), and wiring the **output surfacing ceiling** (SENSE-9 → SCOPE-11).

## 9. Out of scope (for now)

- **Audience/purpose taxonomy for output ceilings** (self-private / internal-self / team / external) — a
  Principal call, carried as a SPEC-0005 open question; SENSE provides the comparator the ceiling reads.
- **Cross-instance bridges / export sanitization** — SCOPE-2, deferred.
- **Span-level redaction** — sensitivity gates at the artifact granularity in v1; sub-document scrubbing
  is later (mirrors RESEARCH-8's tier-based gating).

## 10. Resolved decisions

- **D1 — `private-opinion`/`embargoed` + custom labels rank most-restrictive for the gate (KB-Lead,
  conservative default, tunable).** They aren't a linear extension of `confidential`; for egress/surfacing
  comparison they sit at rank 3 (only `local-only` / explicit Principal override touches them), and any
  **unknown/custom** label resolves the same way (unknown ≠ safe). This is the gate *rank*, not the
  product *meaning* of the label.
- **D2 — classification runs at the ingest boundary**, before Decompose, so every downstream stage sees a
  labeled source; the connector default is applied at the source boundary (SENSE-5).
- **D3 — propagation is computed at the writer** (Connect for entities per CANON-5; the output builder for
  outputs), not as a separate pass — the writer already has the full source set in hand.
- **D4 — Replay: Principal overrides are sticky** (stored on the artifact, re-applied on rebuild); the
  classifier re-runs on Replay but **never** overwrites a `by: principal` label.

## 11. Open questions (carried from SPEC-0005)

- [ ] Audience/purpose → ceiling taxonomy (Principal) — needed to *enforce* surfacing (Slice 3), not to
      ship Slices 1–2 or the researcher gate.
- [ ] Does a Principal **downgrade propagate to descendants**, and is it re-checked on Replay? (SPEC-0005 OQ)
- [ ] Scope of an agent-derived entity spanning multiple source scopes (SPEC-0005 OQ — Scope, not Sensitivity).

## 12. Changelog

- 2026-06-08 — **Slice 1a implemented** (KB-Developer-2). The source frontmatter `sensitivity` label is now
  real, un-hardcoded data with a `sensitivityMeta` provenance block (§7: `by` + `at`); `internal` default
  (SENSE-2) and connector high-confidence signal `by: connector` (SENSE-5) ride capture → archive into
  `source.md` and the `archived` audit event (SENSE-8 classification half). Ships the **comparator**
  `restrictiveness(label)→rank` (SENSE-3, custom/unknown + `private-opinion`/`embargoed` → rank 3) and the
  security-load-bearing **`sensitivityAllowsOrientRead(tier, sensitivity)`** egress/orient gate per the
  ratified D6 map (SENSE-9 — the gate fn; consumer wiring is RESEARCH-22 / SCOPE-11's story), as a
  standalone unit with a fails-before/passes-after regression (unknown label fails closed; no tier reads
  above its ceiling). `Verify` graduated to `test:` for SENSE-1(source)/2/3/5/8/9. **Slice 1b** (override
  SENSE-7 + Panel SENSE-10) and the classifier (Slice 2) follow.
- 2026-06-07 — created (draft). Decomposes SPEC-0005 SCOPE-7/8/9/10/14 into an implementable feature: the
  frontmatter label + provenance (SENSE-1/8), conservative `internal` default (SENSE-2), the **comparator**
  as the single gate source-of-truth (SENSE-3), ingestion-time classification by signal priority with
  uncertain→Review (SENSE-4/5/11), most-restrictive **propagation** at the writers (SENSE-6), sticky
  Principal override across Replay (SENSE-7), and the **consumer wiring** to output surfacing (SCOPE-11) and
  the **researcher egress/orient gate** (SPEC-0028 D6/D8, SENSE-9). Three slices, lowest-risk-first;
  Slice 1 un-hardcodes `internal` so `internal-tenant`/`local-only` researcher orient reads light up,
  Slice 2's classifier lights up `public-web`. Prioritized as the parallel track to SPEC-0028 RESEARCH-21/22
  (Principal, 2026-06-07). `Verify: none-yet` graduates to `test:` per slice as requirement-traced tests land.
