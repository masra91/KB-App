---
spec: SPEC-0058
key: STATE
title: UI State Model — Projection-Backed Reads (no live vault scans on the render path)
type: architecture
status: draft
owners: [Principal, KB-Lead]
related: [SPEC-0017, SPEC-0007, SPEC-0030, SPEC-0035, SPEC-0039, SPEC-0029, SPEC-0037]
created: 2026-06-27
stage: Cross-cutting
supersedes: null
---

# UI State Model — Projection-Backed Reads

> The UI must read KB state **instantly and reliably**, never by scanning the git-backed vault on the
> render path. This is the cure for the chronic "couldn't load / still starting up / app busy / retry /
> timeout / stuck" failures across Explore, Health, and Activity. The architecture already exists
> (SPEC-0017 **SHELL-12**, the `ProjectionStore` backbone) — it was only ever wired to two surfaces.
> This spec **finishes the migration**: every read surface reads a maintained projection, the backend
> **pushes** updates to the renderer, and reads never touch the mutating working tree.

## 1. Problem — the just-in-time-vault-scan anti-pattern (confirmed)

A read-path audit (2026-06-27) found the root cause the Principal named: most views do **live,
on-demand filesystem/git scans of the vault at mount time**, bounded by an 8s timeout (`loadGuard`).
When the vault is large, slow, or mid-write, the scan exceeds the timeout → the view renders
"Couldn't load — the app may be busy or still starting up," or a swallowed error.

Confirmed offenders (read-path = the render path):
- **Explore** (`kb:exploreEntities` / `kb:exploreNeighborhood`) — walks **all** entities (≤2000),
  reads every entity's markdown, and runs an **O(N²)** backlink scan (`linkTraversal`) + reads every
  cited source's `source.md` for titles. Per mount, per focus-change.
- **Health** (`kb:healthReport`) — walks all entities + reads each to detect orphans/thin/dangling.
- **Activity** (`kb:activityFeed` / `Events` / `Lineage`) — **full-rebuilds** the audit index from every
  `audit.jsonl` on the **staging worktree** on every request. A cache (`loadActivityIndex`, HEAD-keyed)
  **exists but the handler bypasses it** (`buildActivityIndex` directly).
- **Registry list views** (jobs/researchers/sources/settings) — read registry files off **staging**
  (the tree the pipeline is concurrently writing) with no coordination → torn-read / race hazard.

Meanwhile **Status** and **Reviews never fail** — because they already read the SHELL-12
`ProjectionStore` (a maintained, last-known-good, in-memory projection; the render path does zero
git/fs/recompute). The good pattern is in the codebase; it was just never extended.

Three secondary defects compound it: (a) the renderer **never receives push** — `ProjectionStore`'s
`onUpdate` hook is unwired to the renderer, so every surface **polls** on an interval and eats the 8s
timeout; (b) Explore/Health swallow the real error in a bare `catch {}`, so failures are undiagnosable;
(c) a not-yet-built projection and a genuine error both surface as the same scary "app busy" string.

## 2. The model — read projections, single invalidation, push not poll

**Source of truth is unchanged.** The git-backed vault (evergreen `main` + `staging`) remains the write
side (SPEC-0007); the pipeline writes through the one canonical-writer lock and `advanceOrCollide`
(unchanged). This spec governs only the **read side**.

1. **Every read surface reads a maintained projection** (`ProjectionStore<T>`, SHELL-12), never a live
   vault scan. The render path does zero `fs`/git/grep/lock/recompute — it returns `current()`, an
   instant last-known-good `Projection<T>` envelope (`{ data, builtAt, stale }`). New projections:
   - **Graph projection** — entities + typed links + **precomputed backlinks** + claims-per-entity +
     source titles. Powers **Explore** and **Health**. Precomputing backlinks kills the O(N²) scan.
   - **Activity projection** — the existing HEAD-keyed audit index, read via the cache and updated
     incrementally on audit append; the render path never full-rebuilds.
   - **Registry projections** — jobs/researchers/sources/intake/watch/instance-settings, cached and
     invalidated on their setter writes (which already serialize through the lock).
2. **One invalidation signal: the canonical advance.** State changes only when a commit advances a ref
   (HEAD move) or a registry setter writes — both already funnel through the canonical-writer lock.
   Projection refresh is **triggered off that seam** (HEAD SHA is the freshness token), not a blind
   cadence alone. The background cadence remains a **backstop**, not the primary path.
3. **Reads compute off a known-good snapshot, never the mutating tree.** A projection that must
   (re)read disk does so off the canonical/evergreen state at a settled HEAD — never the live-writing
   `staging` working tree mid-commit. This removes the torn-read / index.lock race entirely.
4. **Push, not poll.** The backend bridges `ProjectionStore.onUpdate` → `webContents.send` → the
   renderer subscribes and re-reads the (instant) projection. Interval polling is demoted to a slow
   backstop or removed. The timeout-prone pull that produces "couldn't load" goes away.
5. **An honest, calm freshness contract.** Every projection carries `builtAt` + `stale`, plus a cold
   **`warming`** status. A not-yet-built projection shows a calm "indexing…" state that auto-resolves
   via push — **never** the scary "app busy / couldn't load." The `loadGuard` error path is reserved
   for a **genuine** error, and the bare `catch {}` is un-swallowed (the real error is logged/telemetered).
6. **Instant cold start.** The persisted last-known-good projection (SHELL-12 already persists) renders
   the surface immediately on launch, then goes live via the first refresh + push.
7. **Projections are shaped by the UI, not abstractly (design from the screens inward).** Each surface
   declares the exact data its render needs (its view data-contract); the projection serves *precisely*
   that shape — a view gets everything it draws from **one** projection read, never a supplementary live
   fetch, and a projection carries no more than its surfaces consume. (Principal, 2026-06-27: "what
   reliability and the models look like may be driven in detail by the UI needs.") So the redesign and
   the state model co-evolve: as the Vellum UX v2 surfaces firm up what they show, the projection shapes
   follow — these two tracks inform each other rather than running blind.

## 3. Requirements (must unless noted) — `Verify: none-yet → test:`
- **STATE-1** No read-path IPC handler performs a live vault scan (`fs` walk / git / grep) on the render
  path; every read returns a maintained `Projection<T>` from a `ProjectionStore`. `Verify: none-yet → test:`
- **STATE-2** **Explore** reads a **graph projection** (entities + typed links + **precomputed backlinks**
  + claims + source titles); no per-mount full entity walk and **no O(N²) link traversal** on the render
  path. `Verify: none-yet → test:`
- **STATE-3** **Health** reads the same graph projection — orphan/thin/dangling are derived from the
  projection, not a fresh entity walk. `Verify: none-yet → test:`
- **STATE-4** **Activity** reads the **cached** audit index (HEAD-keyed `loadActivityIndex` / incremental),
  never a full rebuild on the render path. `Verify: none-yet → test:`
- **STATE-5** Registry reads (jobs/researchers/sources/intake/watch/settings) are served from a cached
  projection invalidated on their setter writes — not a live read of the `staging` working tree.
  `Verify: none-yet → test:`
- **STATE-6** Projection refresh is **triggered by the canonical advance / registry write** (the lock
  seam, HEAD-keyed), with the background cadence as a backstop only. `Verify: none-yet → test:`
- **STATE-7** Projection (re)computation reads a **settled, known-good** tree, never the `staging`
  working tree mid-write; a read can never observe a torn write or block on `index.lock`.
  `Verify: none-yet → test:`
- **STATE-8** The backend **pushes** projection updates to the renderer (`onUpdate` → `webContents.send`);
  the renderer re-reads on push. Interval polling, where retained, is a slow backstop. `Verify: none-yet → test:`
- **STATE-9** A not-yet-built projection surfaces a calm **`warming`/"indexing…"** state that auto-resolves
  on push — never the "app busy / couldn't load" error string. `Verify: none-yet → test:`
- **STATE-10** The `loadGuard` error fallback is shown only for a **genuine** read error; Explore/Health/
  Activity **un-swallow** their errors (the real cause is logged/telemetered, not discarded). `Verify: none-yet → test:`
- **STATE-11** Every read surface renders **instantly on launch** from the persisted last-known-good
  projection (no first-paint blocked on a compute). `Verify: none-yet → test:`
- **STATE-12** Every projection envelope carries honest freshness (`builtAt` + `stale`); a surface may show
  a subtle "updated · indexing" affordance but must never imply fresh data when stale. `Verify: none-yet → test:`
- **STATE-13** Each projection's shape is defined by its consuming view's **render contract** — the view
  draws everything it shows from a single projection read (no supplementary live fetch), and the
  projection carries no more than its surfaces need. The read model is designed from the screens inward,
  co-evolving with the UX v2 redesign. `Verify: none-yet → test:`

## 4. Slices
- **Slice 0 — stop the bleeding (small, ships first):** Activity uses `loadActivityIndex` (the cache it
  already has); un-swallow the Explore/Health `catch {}`; `loadGuard` distinguishes **warming** (calm)
  from **error** (STATE-4/9/10 partial). Buys immediate reliability before the projections land.
- **Slice 1 — graph projection:** build it; migrate **Explore** + **Health** onto it; precompute
  backlinks (STATE-1/2/3/7/11).
- **Slice 2 — activity projection:** incremental HEAD-keyed index on the backbone (STATE-4/6).
- **Slice 3 — push end-to-end:** bridge `onUpdate` → `webContents.send`; renderer subscription; demote
  polling to backstop (STATE-8).
- **Slice 4 — registry projections:** jobs/researchers/sources/intake/watch/settings cached +
  setter-invalidated (STATE-5/6).

## 5. Out of scope
- Changing the **write** side (pipeline stages, canonical advance, the lock) — unchanged.
- The visual redesign (the Vellum UX v2 language) — parallel track; this is the reliability foundation
  it sits on.
- A general client-side state framework (React/Redux/etc.) — the app is vanilla-DOM; projections +
  push are the model, no framework.
