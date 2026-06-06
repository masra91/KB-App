---
spec: SPEC-0040
key: RICHIN
title: Rich Ingestion
type: feature
status: draft
owners: [KB-Lead, KB-Developer-1]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0003, SPEC-0007, SPEC-0008, SPEC-0013, SPEC-0014, SPEC-0022, SPEC-0033]
supersedes: null
stage: Ingest
---

# Rich Ingestion

> Capture beyond plain text: paste **formatted** content (structure preserved as
> Markdown), drag **many files at once** (one source per file, one batch), and paste
> a **conversation** (speaker turns preserved) — all by enriching the *composer
> surface* and the capture-time text→Markdown normalization, **without touching the
> sacred preservation/archive spine of SPEC-0013.**

## 1. Intent (the why / JTBD)

SPEC-0013 (CAPTURE) delivered the ingest walking skeleton: typed text or dropped
files → immutable `inbox/<ULID>/` units (committed) → archivist drains them into
date-sharded `sources/`. It is deliberately the *thinnest* surface — a textarea and a
drop zone — and it **flattens** anything richer than plain text.

But the Principal's real capture gestures are rarely plain: they **copy a section of
a web page, doc, or email** (headings, lists, links, tables); they **drag a folder's
worth of files in one motion**; they **paste a conversation** worth keeping. Today all
three degrade — formatting is lost, multi-file feels incidental, a transcript becomes
an unattributed wall of text. RICHIN is the job *"capture what I actually copied,
the way I copied it."*

The discipline of this spec: **RICHIN extends only the capture surface and the
capture-time normalization of pasted text into Markdown.** It does **not** change the
preservation contract (CAPTURE-3/4/5/7/9), fire-and-forget (CAPTURE-2), the
inbox→`sources/` archive model, or pull *enrichment* (extraction, entity/claim work)
forward into capture. Capture stays dumb, reliable, and instant; richness lives in the
composer and in one honest text→Markdown step. Every richer input still lands as the
same trusted immutable unit SPEC-0013 already proves out.

## 2. Scope

**In scope:**
- **Rich / formatted paste.** When the clipboard carries an HTML flavor, convert it
  to Markdown (semantic structure only) and capture that as the text payload; preserve
  the original clipboard bytes verbatim as a non-destructive sidecar.
- **Multi-file drag-drop in one gesture.** Drop N files at once → N immutable units,
  one per file, all sharing one `captureBatch` (CAPTURE-14), with per-file feedback and
  failure isolation. A first-class, type-aware *surface* over the existing archive model.
- **Pasted-conversation format.** Detect a conversation paste (or let the Principal
  choose it) and normalize it into a **single** Markdown source with attributed,
  ordered speaker turns.
- **A per-item composer manifest/preview** before capture, so the Principal sees
  exactly what will be preserved (and can remove items first).
- **Pasted image** (clipboard image flavor, no markup) captured as a file unit, same
  as a dropped image.

**Slice 1 (first delivery increment):** rich-text paste (Markdown conversion +
original-clip sidecar + "paste as plain text" escape hatch) **and** multi-file drag
(one-unit-per-file, shared batch, per-file failure isolation + manifest). Conversation
parsing (RICHIN-7/8) and platform-specific transcript adapters land in a following
slice of this same spec. *Per the done-bar, the slice does not redefine "done" — the
spec is done only when all of §4 is delivered end-to-end.*

**Out of scope (for now):**
- **Capture-time extraction / normalization of file *contents*** (PDF→text, docx→md,
  image OCR, audio transcribe). Files are preserved byte-for-byte; extraction stays
  **Enrich's** job (SPEC-0008 §5; SPEC-0013 §5 deferral). RICHIN only makes capture
  *type-aware at the surface*, not extracting.
- **Large/binary pointer or LFS storage.** Inherit SPEC-0013: raw bytes stored in-vault
  at any size; RICHIN only *warns* above a soft threshold (RICHIN-11).
- **New surfaces** — hotkey/tray quick-capture (QCAP) and folder-watch (WATCH) are
  their own specs; RICHIN enriches the **existing in-app composer** only.
- **Inline/embedded-image extraction** from a rich paste — **deferred to Slice 2**
  (KB-Lead). v1 preserves inline/data-URI images **within the `original.html` sidecar
  only** (not extracted to file units); remote `<img>` remain Markdown image references
  in `raw.md`. (See §6.)
- **Non-HTML rich clipboard flavors** (RTF-only sources with no `text/html`) — Slice 1
  handles `text/html` + `text/plain`; RTF→Markdown deferred.

## 3. User flows / feature surface

**Flow A — rich/formatted paste:**
1. The Principal copies a formatted region (web article, doc, email) and pastes into
   the composer.
2. The composer detects an HTML clipboard flavor and converts it to Markdown,
   preserving **semantic structure** — headings, lists, blockquotes, code blocks,
   tables, links, images-by-reference, and inline emphasis (bold/italic/strike/code) —
   while dropping **visual chrome** (colors, fonts, classes, scripts, pixel layout).
3. The composer shows the rendered Markdown preview. A **"paste as plain text"**
   affordance (e.g. ⌘⇧V) bypasses conversion entirely.
4. On *Capture*: the derived Markdown is written as `raw.md` (the captured payload),
   and the **original clipboard HTML is preserved verbatim** as a sidecar
   `original.html` in the same unit. Confirms immediately (fire-and-forget, CAPTURE-2).

What a rich-paste unit writes (extends SPEC-0013 §3, same inbox→archive spine):
```
inbox/<ULID>/
    raw.md               # derived Markdown — the captured payload (kind: text)
    original.html        # the original clipboard bytes, verbatim, non-destructive
    audit.jsonl          # {action:"captured", surface, clip:"html→md", captureBatch, …}
```
`source.md` gains a `clip` provenance block recording the derivation (RICHIN-10):
```markdown
---
id: 01J…
class: primary
kind: text
raw: raw.md
clip:
  format: html→md        # html→md | conversation | plain
  original: original.html # verbatim source bytes; null when paste was plain text
contentHash: sha256:…    # over raw.md; original.html hashed in audit
provenance: { origin: principal, surface: in-app-panel, captureBatch: 01J…, … }
---
```

**Flow B — multi-file drag (one gesture, many files):**
1. The Principal selects several files and drags them onto the drop zone in one motion.
2. The composer shows a **manifest**: each file as a row (icon, name, type, size, a
   *remove* control); unsupported/oversized files are flagged but not blocked.
3. On *Capture*: each file becomes its **own immutable unit** (`raw.<ext>`, `kind:
   file`), all sharing **one `captureBatch`** (CAPTURE-14). Capture confirms immediately.
4. Each file is preserved **byte-for-byte** with `originalName`/`mimeType`/`bytes` in
   provenance; **no content extraction** happens at capture. The archivist drains each
   unit independently into `sources/` exactly as in SPEC-0013.

**Flow C — pasted conversation (later slice):**
1. The Principal pastes a chat transcript (assistant export, Slack copy, generic
   `Name: text` blocks).
2. On a **high-confidence** conversation signal — or via an explicit *"paste as
   conversation"* choice — the composer normalizes it into a **single** Markdown source
   with attributed, ordered turns (a stable turn schema: speaker + content, in order).
   Otherwise it falls back to ordinary rich paste (Flow A).
3. The original clipboard is preserved verbatim as `original.*` (same as Flow A), so a
   misparse is never lossy and is re-derivable. Turns are **not** split into separate
   units — a pasted conversation is *one artifact*; splitting/attribution-as-knowledge
   is Enrich's job.

**Edge / secondary flows:**
- **Pasted image** (clipboard image flavor, no markup) → captured as a **file unit**
  (`raw.<ext>`, `kind: file`), identical to a dropped image; if pasted with text, the
  text unit and image unit share one `captureBatch` (RICHIN-12).
- **Partial multi-file failure** — if one file can't be read, the others still capture;
  the failed one is surfaced in the manifest and never silently dropped (ORCH-12).
- **Empty / degenerate paste** — a plain-text paste with no HTML flavor behaves exactly
  like SPEC-0013 typed text (single `raw.md`, no sidecar). RICHIN adds nothing to the
  common case's cost.
- **Preservation spine unchanged** — every RICHIN unit flows through the *same*
  commit-before-process, immutable, add-only inbox→`sources/` path; nothing in capture's
  durability story changes (RICHIN-9).

## 4. Requirements

| ID         | Priority | Statement (short)                                                                 | Verify   | Traces |
| ---------- | -------- | --------------------------------------------------------------------------------- | -------- | ------ |
| RICHIN-1   | must     | The composer accepts **rich/formatted paste** and converts clipboard HTML → Markdown, preserving semantic block + inline structure; visual-only styling is dropped | none-yet | VISION-13; INGEST-2 |
| RICHIN-2   | must     | A rich paste **preserves the original clipboard bytes verbatim** as a sidecar (`original.html`) alongside the derived `raw.md`; conversion is non-destructive and re-derivable | none-yet | INGEST-2; DATA-2; REPLAY-* |
| RICHIN-3   | should   | A **"paste as plain text"** affordance bypasses conversion and stores the literal text as `raw.md` (no sidecar) | none-yet | VISION-1 |
| RICHIN-4   | must     | The composer accepts **drag-drop of multiple files in one gesture**, writing one immutable unit per file, all sharing one `captureBatch`; per-file capture is **independent** (one failing does not block the others) | none-yet | CAPTURE-14; ORCH-12; DATA-1 |
| RICHIN-5   | must     | Multi-file capture is **type-agnostic at the surface**: files are preserved byte-for-byte with `originalName`/`mimeType`/`bytes` in provenance; **no capture-time extraction/normalization** of file contents | none-yet | CAPTURE-6; INGEST-4 |
| RICHIN-6   | should   | Before commit the composer shows a **per-item manifest/preview** (files: name/type/size/removable; text/paste: rendered preview) so the Principal sees exactly what will be captured | none-yet | CAPTURE-11; VISION-2 |
| RICHIN-7   | must     | A pasted **conversation** (high-confidence signal or explicit choice) is normalized into a **single** Markdown source with attributed, ordered speaker turns; turns are **not** split into separate units | none-yet | DATA-1; CAPTURE-14; INGEST-2 |
| RICHIN-8   | must     | Conversation parsing is **conservative + non-destructive**: it triggers only on high confidence / explicit choice, falls back to ordinary rich paste otherwise, and always keeps the original clipboard as the `original.*` sidecar | none-yet | INGEST-2; DATA-2 |
| RICHIN-9   | must     | RICHIN changes **only the composer surface + capture-time text→Markdown normalization**; it does **not** alter the inbox/commit/archive preservation spine (CAPTURE-3/4/5/7/9) or fire-and-forget (CAPTURE-2) | none-yet | CAPTURE-2,3,4; INGEST-2 |
| RICHIN-10  | should   | `source.md` records **capture-fidelity provenance** — a `clip` block (`format: html→md \| conversation \| plain`, `original: <sidecar\|null>`) for pasted items — so the derivation is auditable | none-yet | DATA-5; CAPTURE-6,13 |
| RICHIN-11  | may      | The composer **soft-warns** (never blocks) when a paste/file exceeds a tunable threshold — v1: **>~1 MB pasted text** / **>~25 MB file**; preservation stays in-vault at any size | none-yet | (SPEC-0013 §5) |
| RICHIN-12  | should   | A **pasted image** (clipboard image flavor, no markup) is captured as a **file unit** (`raw.<ext>`, `kind: file`), identical to a dropped image; if pasted with text, both units share one `captureBatch` | none-yet | CAPTURE-14; DATA-1 |

### RICHIN-1 — Rich paste → semantic Markdown
- **Status:** draft · **Priority:** must
- **Statement:** When a paste carries an HTML clipboard flavor, the composer **MUST**
  convert it to Markdown preserving **semantic structure** — headings, lists,
  blockquotes, code blocks, tables, links, images-by-reference, and inline emphasis
  (bold/italic/strikethrough/inline-code) — and **MUST** drop visual-only styling
  (colors, fonts, CSS classes, scripts, pixel layout).
- **Rationale:** Structure *is* knowledge; chrome is noise. Converting to Markdown
  keeps every downstream stage (Decompose/Claims/Connect) reading the one uniform
  representation it already reads for typed text, so RICHIN adds zero new burden
  downstream while stopping the silent loss of headings/lists/tables on paste.
- **Traces:** VISION-13, INGEST-2
- **Verify:** none-yet · *(later: `test:` the HTML→MD normalizer on a fixture corpus)*

### RICHIN-2 — Original clipboard preserved (non-destructive)
- **Status:** draft · **Priority:** must
- **Statement:** A rich paste **MUST** preserve the original clipboard payload
  byte-for-byte as a sidecar (`original.html`) in the same unit, with `raw.md` as the
  captured (derived) payload. The sidecar **MUST** be written only when an HTML flavor
  actually differs from plain text (a plain paste stays a lone `raw.md`).
- **Rationale:** HTML→Markdown is inherently lossy and converter-dependent.
  Preservation-first (INGEST-2): keeping the original bytes means the true source of
  truth is never destroyed and a better converter can re-derive Markdown later (Replay,
  SPEC-0022). The "only when it differs" rule keeps the common plain-text path free of
  empty sidecars.
- **Traces:** INGEST-2, DATA-2, REPLAY-*
- **Verify:** none-yet

### RICHIN-4 — Multi-file drag: one unit per file, one batch, isolated
- **Status:** draft · **Priority:** must
- **Statement:** A single drag of multiple files **MUST** produce one immutable unit
  per file (`raw.<ext>`, `kind: file`), each its own ULID, all stamped with one shared
  `captureBatch`. Per-file capture **MUST** be independent: a file that fails to read
  **MUST NOT** block or discard the others.
- **Rationale:** This is the *surface* realization of CAPTURE-14 (per-payload units,
  batch-linked) made first-class for the many-files gesture. Independence preserves
  fire-and-forget and matches the orchestrator's per-item isolation (ORCH-12): the batch
  is a provenance breadcrumb, **not** an atomic transaction.
- **Traces:** CAPTURE-14, ORCH-12, DATA-1
- **Verify:** none-yet

### RICHIN-5 — Type-aware surface, no capture-time extraction
- **Status:** draft · **Priority:** must
- **Statement:** Multi-file capture **MUST** preserve each file byte-for-byte and
  record `originalName`/`mimeType`/`bytes` in provenance, and **MUST NOT** perform
  capture-time extraction or normalization of file *contents* (no PDF/docx→text, no
  OCR, no transcode). The surface MAY use type only for icons/affordances/warnings.
- **Rationale:** Extraction is enrichment; pulling it into the sacred capture path adds
  failure modes that threaten the fire-and-forget preservation guarantee (CAPTURE-2/7).
  Keep capture dumb and reliable; let Enrich researchers extract from the preserved
  bytes later. Recording `mimeType` now lets Enrich route by type without re-deciding.
- **Traces:** CAPTURE-6, INGEST-4
- **Verify:** none-yet

### RICHIN-7 — Conversation paste → single attributed source
- **Status:** draft · **Priority:** must
- **Statement:** A pasted conversation, recognized with **high confidence** or chosen
  explicitly, **MUST** be normalized into a **single** Markdown source preserving
  attributed, ordered speaker turns (a stable turn schema). It **MUST NOT** split turns
  into separate source units.
- **Rationale:** A pasted transcript is *one artifact* the Principal chose to keep
  whole; one paste = one arrival = one source keeps the immutability/batch model clean
  (CAPTURE-14). Preserving *who said what, in order* keeps the highest-value signal so
  Claims/Decompose can attribute later; splitting per-turn front-runs Enrich and
  destroys the conversation-as-context.
- **Traces:** DATA-1, CAPTURE-14, INGEST-2
- **Verify:** none-yet

### RICHIN-9 — No regression to the preservation spine
- **Status:** draft · **Priority:** must
- **Statement:** RICHIN **MUST** confine its changes to the composer surface and the
  capture-time text→Markdown normalization. It **MUST NOT** alter the commit-before-
  process, immutable, add-only inbox→`sources/` path (CAPTURE-3/4/5/7/9) or the
  fire-and-forget confirm (CAPTURE-2). Every RICHIN unit flows through the **same** spine.
- **Rationale:** SPEC-0013's sacred half is the thing the whole product trusts. Stating
  the non-regression as a normative requirement makes "did capture stay durable?" a
  testable gate on every RICHIN change, not an assumption.
- **Traces:** CAPTURE-2,3,4, INGEST-2
- **Verify:** none-yet · *(later: reuse SPEC-0013 ingest/orchestrator tests as a guard)*

## 5. Design forks — RATIFIED by KB-Lead (2026-06-06)

> Each fork states the question, the options, the **recommendation**, and why. All
> three were **ratified by KB-Lead on product review (2026-06-06)**; recorded here as
> the locked decisions.

### Fork 1 — Formatting fidelity: how much to preserve (Markdown vs raw)
- **Question:** On a rich paste, what is the durable source of truth — flatten to plain
  text, store only derived Markdown, or store Markdown *and* keep the original bytes?
- **Options:** (a) flatten to plain text; (b) convert to Markdown, discard HTML;
  (c) **Markdown is the captured payload (`raw.md`), original clipboard HTML kept
  verbatim as a sidecar (`original.html`).**
- **Decision: (c) — RATIFIED (KB-Lead).** *"Re-derivable-on-Replay is the right reason;
  the verbatim original honors INGEST-2 immutability."*
- **Rationale:** Conversion is lossy and converter-versioned; (a) throws away the
  structure that's the whole point, (b) makes the lossy step irreversible. (c) honors
  preservation-first (INGEST-2/CAPTURE-4) — the true bytes are never destroyed and
  Markdown is re-derivable on Replay — while keeping a single uniform `raw.md` for every
  downstream stage. Scope the conversion to semantic structure (headings/lists/quotes/
  code/tables/links/emphasis), drop visual chrome, and offer "paste as plain text" as
  an explicit opt-out. Sidecar only when HTML actually differs from plain text.

### Fork 2 — Per-type file handling on multi-file drag
- **Question:** When N heterogeneous files arrive at once, do we extract/normalize per
  type at capture, or preserve uniformly and defer extraction?
- **Options:** (a) per-type capture-time extraction (PDF→text, docx→md, OCR);
  (b) **uniform byte-for-byte preservation, one unit per file, `mimeType` recorded,
  extraction deferred to Enrich**; the surface is type-aware only for icons/warnings.
- **Decision: (b) — RATIFIED (KB-Lead)** (matches CAPTURE-4/14).
- **Rationale:** (a) drags enrichment into the sacred capture path and multiplies
  failure modes against the fire-and-forget guarantee — exactly what SPEC-0013 §5 and
  SPEC-0008 already defer to Enrich. (b) keeps capture dumb/reliable, reuses CAPTURE-14
  one-unit-per-payload, and still gives Enrich everything it needs (`mimeType`,
  original bytes) to route extraction later. Type-awareness stays at the *surface*
  (affordances, soft-size warning), not in preservation.

### Fork 3 — Chat-paste parsing
- **Question:** How do we treat a pasted conversation — ignore it, structure it into one
  attributed source, or split each turn into its own source?
- **Options:** (a) ordinary rich text (no special handling); (b) **detect/elect →
  normalize to a single Markdown source with attributed ordered turns**; (c) split each
  turn into a separate unit.
- **Decision: (b) — RATIFIED (KB-Lead)**, gated on high-confidence detection or an
  explicit "paste as conversation" choice, with original-clip sidecar always kept;
  no turn-splitting at ingest (that's Enrich's job).
- **Rationale:** (a) loses attribution (who-said-what is the value); (c) destroys the
  conversation-as-context and front-runs Enrich's semantic decomposition. (b) keeps one
  artifact = one source (CAPTURE-14), preserves the ordering/attribution signal for
  downstream Claims, and — because detection is conservative + reversible and the
  original clipboard is always preserved — a misparse is never lossy. Slice 1 ships a
  small heuristic parser + explicit affordance for common shapes (assistant exports,
  Slack, `Name: text`); per-platform adapters are a later slice.

## 6. Open questions

**Resolved on KB-Lead product review (2026-06-06):**
- [x] **HTML→Markdown converter** — use a **reputable, well-established HTML→Markdown
      library, pinned + ≥7-day-aged (E1)**; **do not hand-roll HTML parsing**
      (correctness/security). The single dependency must be justified at implementation.
- [x] **Soft size-warning threshold (RICHIN-11)** — **soft-warn, never block**; v1
      (tunable): **>~1 MB pasted text / >~25 MB file**. Preservation stays
      in-vault-at-any-size regardless.
- [x] **Inline/embedded images in a rich paste** — **defer extraction to Slice 2.** v1
      preserves inline/data-URI images **within the `original.html` sidecar only** (not
      extracted to file units); remote `<img>` stay as Markdown image references in
      `raw.md`. (Re-decide remote-fetch-vs-Enrich when Slice 2 is scoped.)
- [x] **`captureBatch` for a single rich paste** — only mint a `captureBatch` when a
      gesture yields **>1 unit** (e.g. text + pasted image); a lone paste needs none.
      Matches SPEC-0013's "arrived together" semantics.

**Still open:**
- [ ] **Non-HTML rich flavors (RTF only)** — some native apps offer RTF without
      `text/html`. Slice 1 handles `text/html`+`text/plain`; RTF→Markdown deferred.
- [ ] **Conversation turn schema + platform adapters** — the stable turn representation
      (headings vs a fenced metadata block) and which platforms get dedicated adapters
      in the conversation slice.

## 7. Changelog

- 2026-06-06 — created (draft). Extends SPEC-0013 (CAPTURE): enriches the in-app
  composer surface + capture-time text→Markdown normalization for **rich/formatted
  paste**, **multi-file drag**, and **conversation paste**, without changing the
  preservation/archive spine. Reserved RICHIN-1…12. Three design forks recommended for
  KB-Lead ratification. Slice 1 = rich-text paste + multi-file drag; conversation
  parsing follows in-spec.
- 2026-06-06 — renumbered SPEC-0037 → **SPEC-0040** per KB-PM's allocation of record
  (0037=WATCH, 0038=QCAP, 0039=EXPLORE, 0041=INTAKE) after a 4-way next-free collision
  (main topped at 0036).
- 2026-06-06 — **product-APPROVED by KB-Lead; all three forks RATIFIED.** Open-question
  answers folded in: HTML→MD via a reputable pinned ≥7-day library (no hand-rolling);
  RICHIN-11 soft-warn thresholds set (>~1 MB text / >~25 MB file, never block); inline-
  image extraction deferred to Slice 2 (v1 keeps them in `original.html`); `captureBatch`
  minted only for multi-unit gestures. Cleared to KB-QD gate-2.
