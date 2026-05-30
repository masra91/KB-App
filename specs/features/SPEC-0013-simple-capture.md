---
spec: SPEC-0013
key: CAPTURE
title: Simple Capture (v1)
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0003, SPEC-0007, SPEC-0008, SPEC-0009, SPEC-0014]
supersedes: null
stage: Ingest
---

# Simple Capture (v1)

> The first time the product delivers half its reason to exist — *quick capture in*.
> Type text or drop files into an in-app panel; each item is preserved as an
> immutable primary source in the vault inbox and committed, then archived into
> `sources/` by the orchestration engine. The thinnest honest slice of the Ingest
> spine (SPEC-0008).

## 1. Intent (the why / JTBD)

VISION-13 ranks *"quick capture, effortless recall"* above all. SETUP (SPEC-0009)
built the vault + shell; nothing yet *puts anything in*. This story is the **ingest
walking skeleton**: the smallest end-to-end path that lets the Principal send data to
the KB and trust it's preserved — *fire and forget* (VISION-1).

It is deliberately an **archive-only skeleton**: it exercises the sacred half of the
Ingest spine (arrive → archive, preservation-first; INGEST-2/8) honestly, and stubs
classify/catalog/enqueue to conservative defaults. Its real payoff is proving the
**capture surface + the orchestration harness** (SPEC-0014) end-to-end on the
simplest input kinds, so every richer surface and stage builds on a trusted base.

## 2. Scope

**In scope:**
- An **in-app capture panel** (reuses the existing Electron window): a text area +
  a file **drop zone**. Input kinds: **typed/pasted text** and **dropped files**.
- **Arrive → Archive** of the Ingest spine: write each item as an immutable primary
  source unit into the vault **inbox**, commit, then the engine moves it into
  `sources/` with a catalog record and conservative classification.
- **Fire-and-forget** UX: capture returns immediately on preservation.
- A **minimal status** read (queue depth / archiving) so the Principal sees it work.
- Keeps working **headless** (window closed) via the orchestrator (SPEC-0014).

**Out of scope (for now):**
- Other surfaces — **hotkey quick-capture bar** and **tray sheet** (their own later
  spec) and programmatic **folder-watch** / proactive intake.
- **Enrichment**: entity extraction, summaries, links — the archived source is merely
  *enqueued* conceptually; no Enrich stage runs yet.
- **Rich classification**: real scope/sensitivity inference (v1 = conservative
  defaults only); routing uncertain items to Review.
- **Dedup / re-ingestion**, large/binary **pointer+extraction** optimization,
  multi-Instance — all deferred (see Open Questions / SPEC-0008).

## 3. User flows / feature surface

**Primary flow — capture (the Principal):**
1. Open the app window; the capture panel is present.
2. Type/paste text, **and/or** drag one or more files onto the drop zone.
3. Hit *Capture*. The panel confirms **immediately** ("captured") and clears — the
   Principal moves on. *Fire and forget.*
4. In the background the item is preserved and, shortly after, archived. The panel's
   status reflects queue depth shrinking as items are archived.

**What capture writes (preservation-first; each payload is its own self-contained unit):**
```
<vault>/inbox/<ULID>/
    raw.txt              # typed/pasted text, verbatim         (text item)
    raw.<ext>            # dropped file bytes, verbatim         (file item)
    audit.jsonl          # {action: "captured", surface, ts, originalName, contentHash, captureBatch}
```
- Ids are **in-house ULIDs** (48-bit UTC time prefix + crypto random, Crockford
  base32): globally unique, lexicographically time-sortable, no dependency.
- **One ULID per payload, minted up front.** A single Capture click with text + N
  files writes **N+1 independent units** — each with its own ULID/folder — all sharing
  one **`captureBatch`** id (a provenance breadcrumb meaning "arrived together"). No
  shared-ULID merge to undo later; semantic "this text describes these images" links
  are added by **Enrich** as derived edges, never by mutating a source.
- Each raw payload is **byte-for-byte immutable**, its folder **add-only** and committed
  to the canonical tree **before** anything processes it (INGEST-2). v1 stores raw bytes
  **in-vault at any size** (large/binary pointer storage is parked; see §5).
- **Inbox is a contract, not a fixed shape (forward-compat):** an inbox entry is *either*
  a canonical `<ULID>/` unit (our panel pre-canonicalizes) *or* a **foreign drop** (a
  loose file from another app / direct disk drop). v1 builds only the canonical path; the
  archivist's `normalize()` step (ORCH-14) is specced to adopt foreign drops later
  (mint ULID, `origin: external`) without redesign.

**What the engine (archivist stage, SPEC-0014) does, per item:**
```
sources/<YYYY>/<MM>/<DD>/<ULID>/        # date-shard derived from the ULID's UTC time
    raw.txt | raw.<ext>  # the same immutable bytes, moved (never rewritten)
    source.md            # catalog record (below)
    audit.jsonl          # capture event + {action: "archived", ts, decisions}
```
The **`source.md`** catalog record (identity + classification; *history* lives in
`audit.jsonl`):
```markdown
---
id: 01JABCDEF7Q2…
class: primary             # primary (Principal) | secondary (agent/research)  ← DATA-2
kind: text                 # text | file
scope: global              # v1 conservative default
sensitivity: internal      # v1 conservative default
raw: raw.txt
contentHash: sha256:9f86d0…
capturedAt: 2026-05-30T18:22:04Z
archivedAt: 2026-05-30T18:22:09Z
provenance:
  origin: principal        # principal | agent | external
  surface: in-app-panel    # in-app-panel | folder-drop | agent:<name>
  captureBatch: 01JB-ATCH… # links units captured in one gesture
  archivedBy: "archivist · copilot session 01JABD…"
# file items also add near `raw`: originalName, mimeType, bytes
---

call Steve re: Q3 budget     # text → body carries the content;  file → body embeds ![[raw.png]]
```
1. A fresh archivist session reads the one inbox unit and returns a **structured
   decision** (kind, `class: primary`, scope=`global`, sensitivity=`internal`).
2. The orchestrator writes `source.md`, moves the unit into the date-sharded
   `sources/` path, appends the archive audit event, commits **per item**, and
   advances the canonical tree.
3. The item is now a preserved, cataloged, discoverable primary source.

**Edge flows:**
- **Crash/restart mid-archive** — the unit is still in `inbox/`; on restart the
  orchestrator re-reads and re-archives it. Nothing is lost (INGEST-8 / ORCH-4,13).
- **Archive failure on an item** — the unit stays in `inbox/`, flagged; it does not
  block other items and is never dropped (ORCH-12).
- **Window closed** — capture/archiving continue headless (SPEC-0014 / VISION-10).

## 4. Requirements

| ID         | Priority | Statement (short)                                                  | Verify   | Traces |
| ---------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| CAPTURE-1  | must     | An in-app panel lets the Principal capture **typed/pasted text and/or dropped files** | none-yet | VISION-1,2 |
| CAPTURE-2  | must     | Capture is **fire-and-forget**: it confirms as soon as the item is preserved, never blocking on downstream processing | none-yet | VISION-1,13 |
| CAPTURE-3  | must     | Each item is written as a self-contained unit into the vault **inbox** and **committed before any processing** | none-yet | INGEST-2; LIFE-2 |
| CAPTURE-4  | must     | The raw payload is stored **byte-for-byte immutable** (text→`raw.txt`, file→`raw.<ext>`) and never edited | none-yet | DATA-2; INGEST-2 |
| CAPTURE-5  | must     | Each item gets a **globally-unique id** and its own folder; capture is **add-only** so concurrent capture/archiving never conflict | none-yet | DATA-9; ORCH-6 |
| CAPTURE-6  | must     | Capture records **arrival provenance** (surface, timestamp, original filename, content hash) with the item | none-yet | INGEST-3; DATA-5 |
| CAPTURE-7  | must     | Once committed to inbox, the item is **durably preserved even if archiving never runs or fails** | none-yet | INGEST-8; PRIN-1 |
| CAPTURE-8  | must     | After preservation the item is **enqueued for archiving** (left in the queue + orchestrator poked) | none-yet | INGEST-6; ORCH-4 |
| CAPTURE-9  | must     | Archiving **moves** each item into a date-sharded `sources/` folder with a `source.md` catalog record, committed per item | none-yet | INGEST-3,5; DATA-1 |
| CAPTURE-10 | must     | v1 classification is **conservative defaults only** (scope=`global`, sensitivity=`internal`); rich classify deferred to Enrich | none-yet | INGEST-4; SCOPE-8 |
| CAPTURE-11 | should   | The panel shows **minimal pipeline status** (queue depth / items archiving) so the Principal sees progress | none-yet | ORCH-10 |
| CAPTURE-12 | must     | Capture **and** archiving keep working when the window is closed (headless) | none-yet | VISION-10; ORCH-1 |
| CAPTURE-13 | must     | Every source records a **`class` (primary\|secondary)** and a **`provenance`** block (origin, surface, captureBatch, archivedBy); v1 = `primary`/`principal` | none-yet | DATA-2,5 |
| CAPTURE-14 | must     | A capture with multiple payloads writes **one unit per payload**, each its own ULID, linked by a shared **`captureBatch`** id; semantic links are deferred to Enrich | none-yet | DATA-1,3 |
| CAPTURE-15 | must     | Ids are **in-house ULIDs** (time-sortable, unique, no dependency); the `sources/` date shard is derived from the ULID's UTC timestamp | none-yet | ENG-5; DATA-9 |

### CAPTURE-3 — Preserve to inbox, commit, *then* process
- **Status:** draft · **Priority:** must
- **Statement:** On capture, the item **MUST** be written into `inbox/<id>/` and
  committed to the canonical vault tree **before** any classification or archiving
  touches it.
- **Rationale:** This is the Ingest spine's sacred half (INGEST-2): the raw item
  becomes durable ground truth the instant it's committed, independent of whatever
  downstream succeeds or fails.
- **Traces:** INGEST-2, LIFE-2, DATA-2
- **Verify:** none-yet

### CAPTURE-5 — Unique unit, add-only, conflict-free
- **Status:** draft · **Priority:** must
- **Statement:** Each captured item **MUST** receive a globally-unique id and be
  stored as its own folder containing its raw payload (and audit); capture **MUST**
  only ever *add* such folders.
- **Rationale:** Unique per-item folders + add-only writes make capture↔archiving and
  concurrent captures conflict-free by construction (no shared file to contend on),
  which is what lets the SPEC-0014 worktree merges always fast-forward cleanly.
- **Traces:** DATA-9, ORCH-6
- **Verify:** none-yet

### CAPTURE-10 — Conservative classification, deferred richness
- **Status:** draft · **Priority:** must
- **Statement:** v1 **MUST** classify every archived source with conservative
  defaults (`global` scope, `internal` sensitivity) and **MUST NOT** attempt richer
  inference; real classification + Review routing are deferred to Enrich.
- **Rationale:** Archive-only skeleton — defaults keep preservation honest without
  pulling enrichment forward. INGEST-4's "conservative defaults unless a high-
  confidence signal says otherwise" with, in v1, no such signal yet.
- **Traces:** INGEST-4, SCOPE-8
- **Verify:** none-yet

### CAPTURE-14 — Per-payload units, batch-linked
- **Status:** draft · **Priority:** must
- **Statement:** A single capture containing multiple payloads **MUST** produce one
  unit per payload, each with its own ULID identity, and **MUST** stamp all of them
  with a shared `captureBatch` id in provenance. It **MUST NOT** bundle heterogeneous
  payloads into a single source.
- **Rationale:** One source = one artifact keeps hashing, immutability, and per-artifact
  lineage/replay clean; `captureBatch` preserves the "arrived together" fact without
  forcing a bundle. The richer "this text describes these images" relationship is
  *derived knowledge* Enrich adds later as a versioned link — sources stay frozen.
- **Traces:** DATA-1, DATA-3
- **Verify:** none-yet

## 5. Open questions

- [x] **Item id scheme** — resolved: **in-house ULID** (no dependency; ENG-5). Unique,
      UTC-time-sortable; names the folder; the date shard derives from it (CAPTURE-15).
- [x] **`source.md` frontmatter schema** — resolved (§3): `id`, `class` (primary|
      secondary), `kind`, `scope`, `sensitivity`, `raw`, `contentHash`, `capturedAt`,
      `archivedAt`, `provenance{origin,surface,captureBatch,archivedBy}`; file extras
      `originalName/mimeType/bytes`; body carries text or embeds the file. Pins
      SPEC-0008's "catalog representation". `source.md` = identity; `audit.jsonl` = history.
- [x] **Shard scheme** — resolved: date-shard `sources/<YYYY>/<MM>/<DD>/<ULID>/`
      (UTC-derived from the ULID), flat `inbox/<ULID>/`.
- [x] **Text + files in one capture** — resolved: **one unit per payload**, linked by a
      shared `captureBatch` id (CAPTURE-14).
- [x] **Inbox shape / non-ULID arrivals** — resolved: inbox is a *contract* accepting a
      canonical `<ULID>/` unit **or** a foreign drop; v1 builds the canonical path only,
      the archivist `normalize()` (ORCH-14) adopts foreign drops later.
- [x] **Status transport** — resolved: panel reads queue depth directly from `inbox/`;
      current-item/worker-state from a `status.json` the orchestrator writes to
      `.kb/cache/` (ORCH-10).
- [ ] **Dedup** *(deferred)* — same bytes twice = two items in v1; `contentHash` is
      already stored, so content-hash dedup (index + policy) is a clean later pass.
- [ ] **Large/binary files** *(deferred)* — v1 stores raw bytes **in-vault at any size**
      (preservation-first); external pointer/LFS storage and text **extraction**
      (Enrich's job) are parked until real large files arrive.

## 6. Changelog

- 2026-05-30 — created (draft). First ingest surface + first user of the
  orchestration engine (SPEC-0014). Archive-only skeleton: in-app text+file capture →
  immutable inbox unit (committed) → archivist moves to date-sharded `sources/` with a
  catalog record and conservative classification defaults.
- 2026-05-30 — resolved v1 design forks (in-house ULID; date-shard sources / flat inbox;
  enriched `source.md` with `class`+`provenance`; per-payload units + `captureBatch`;
  inbox-as-contract with deferred foreign-drop `normalize`; status via inbox-count +
  `.kb/cache/status.json`). Added CAPTURE-13/14/15. Parked dedup + large-binary storage/
  extraction.
