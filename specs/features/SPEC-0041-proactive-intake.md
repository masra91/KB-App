---
spec: SPEC-0041
key: INTAKE
title: Proactive Intake
type: feature
status: draft
owners: [KB-Developer-2, KB-Lead, Principal]
created: 2026-06-06
updated: 2026-06-06
related: [SPEC-0003, SPEC-0004, SPEC-0005, SPEC-0006, SPEC-0007, SPEC-0008, SPEC-0018, SPEC-0023, SPEC-0027, SPEC-0028]
supersedes: null
stage: Ingest
---

# Proactive Intake

> The KB **reaches out on a schedule** and pulls the Principal's external feeds — email,
> RSS/news, calendar — **into the vault as immutable primary sources**, then hands each
> item to the shared Ingest spine (SPEC-0008). It is the *automated arrival surface*:
> a standing subscription + a cadence, not a manual capture and not a research question.
> Read-only w.r.t. the world (AUTO-6), BYOA (no stored secrets), bounded, audited.

## 1. Intent (the why / JTBD)

VISION-7: *"the KB proactively gathers info from connected sources (email, news, calendar)
on a schedule."* LIFE-1: *"ingestion is available to the Principal **and to automated
actions/agents/cron**."* The Principal does not want to copy-paste their newsletters, mail,
and meetings into the KB by hand — they want to **subscribe a feed once** and have its items
flow in on a cadence, preserved as ground truth and enriched like anything else.

JTBD: *"keep my KB fed with what's new in my world — my inbox, my subscriptions, my
calendar — without me ferrying it in by hand."* The trigger is **time + a standing
subscription**; the payoff is a KB that stays current on its own (VISION-7, LIFE-8).

INTAKE owns the **proactive arrival surface**. It does not own preservation, classification,
or enrichment (that is the SPEC-0008 INGEST spine), nor the scheduling engine (SPEC-0023
JOBS). It composes them: *an `intake` job that, when it fires, pulls new feed items and
calls the Ingest pipeline for each.*

## 2. Scope

**In scope (v1):**
- A **connector registry**: each subscription is a per-vault job `{id, type, schedule,
  enabled, config}` (a SPEC-0023 `intake` job type).
- **Pulling** new items from a feed on a recurring cadence (JOBS named presets), preserving
  each as a **primary source** via the INGEST spine.
- **Built-in connector templates (Slice 1):** **RSS/Atom** (public, no-auth) and **M365 mail**
  (internal-tenant, reusing the SPEC-0028 M365 OAuth-MCP BYOA substrate).
- **Recurring-item dedup / idempotency** — never re-archive an item already pulled.
- **Connector-default classification** (scope + sensitivity, SCOPE-14) at ingestion.
- **Control-Panel management** (add/configure/enable/run-now/last-run) — a Sources surface.

**Deferred to Slice 2:**
- **M365 calendar** — the mutable-event-snapshot semantics (events move/cancel → new source
  vs. update vs. contradiction) are real complexity; v1 stays clean as RSS + M365-mail
  (KB-Lead product ruling, 2026-06-06).

**Out of scope (for now):**
- **Preservation / classify / catalog / enqueue** — that is the INGEST spine (SPEC-0008);
  INTAKE *calls* it, it does not reimplement it.
- **The scheduling engine** — SPEC-0023 JOBS owns registry/wake/single-flight/journal/
  promotion; INTAKE is a job *type*.
- **Enrichment** of pulled items (Decompose/Connect/Claims) — happens downstream, unchanged.
- **External corroboration / "tell me more about X"** — that is RESEARCH (SPEC-0028). See §3.
- **Raw IMAP / CalDAV** connectors — deferred until a BYOA (no-stored-secret) auth path
  exists (see fork F2, §7).
- **Writing back to feeds** (mark-as-read, delete, send, RSVP) — forbidden (AUTO-6, §5
  INTAKE-7).
- **Folder-Watch** (local programmatic ingress) — that is WATCH, a separate Ingest surface.

## 3. The boundary fork — INTAKE vs RESEARCH (must-resolve)

This is the spec's load-bearing decision. INTAKE and RESEARCH are both *scheduled external
pulls over BYOA connectors* — they look alike and share infrastructure — but they are
**different jobs producing different things**, and conflating them would corrupt the
source model. **Recommendation: keep them as separate specs, sharing the JOBS scheduler,
the INGEST spine, and the connector/BYOA-auth substrate — do NOT fold.**

### The one-axis test

> **Does the external item enter the KB as a _primary source the KB is built on_ (INTAKE),
> or as a _cited secondary source corroborating something already in the KB_ (RESEARCH)?**

| Axis | **INTAKE** | **RESEARCH** (SPEC-0028) |
| ---- | ---------- | ------------------------ |
| **Source kind** | **Primary** (origin: primary) — the item itself | **Secondary** (origin: secondary) — a cited findings-note |
| **Trigger** | **Subscription + time** — "there's a new item in my feed" | **Request / topic** — a `research-request` (what/why/context) or a standing research prompt |
| **Question it answers** | *"What's new in my world?"* | *"Tell me more about X."* |
| **Relationship to KB state** | None required — pulls regardless of existing topics; **seeds** new topics | Reaches out **about** an existing term/topic; **corroborates/expands** it |
| **Trust posture** | Preserved as ground truth (still classified); the item *is* the source | Never trusted blindly — citation-rich, conflict→Review, untrusted-content-as-data |
| **Egress** | Authenticated read of the Principal's **own** feeds; no outbound query built from KB content | Outbound queries built from the request (D6a); egress-tier gated against KB sensitivity |
| **Downstream** | New primary source → full Ingest → Enrich | Secondary source → Decompose/Connect/Claims as corroboration |
| **Engine reused** | SPEC-0023 JOBS (`intake` job type) | SPEC-0023 JOBS (`researcher` job type, D5) |

### Resolving the genuine collision: the scheduled M365 mail researcher

SPEC-0028 already ships a *scheduled M365 researcher* whose canonical example is *"any email
updates I should know?"* This is the one real overlap, and the line is crisp:

- The **M365 researcher** *queries* mail in service of a question and returns **one cited
  secondary findings-note** ("here's what I found about project X in your mail"). The mailbox
  is searched (request-only `buildOutboundQuery`), not subscribed; the mail is **not**
  preserved as primary sources.
- **INTAKE** *subscribes* to a mailbox/folder and brings **each matching message in as its
  own immutable primary source**, to be decomposed into entities and claims. It is *"my
  project inbox is now part of my KB,"* not *"go look something up in my mail."*

So: **same connector substrate (M365 OAuth-MCP, BYOA), opposite jobs.** A Principal who wants
their newsletters and project mail to *become KB content* configures an **INTAKE** connector;
a Principal who wants a *daily digest answering a standing question* configures a **scheduled
RESEARCH** researcher. Both can coexist over the same M365 auth.

### Why not fold INTAKE into RESEARCH

1. **Source ontology (the decisive reason).** DATA-1/DATA-2 split Sources into **primary**
   (the Principal's own, ground truth) and **secondary** (external corroboration) along a
   deep mutability/trust invariant. RESEARCH is *defined* to produce **secondary** sources
   (RESEARCH-5/6/12: cited, externally-sourced, untrusted-content-as-data). Routing the
   Principal's own subscribed feeds through that framework would mislabel primary sources as
   secondary corroboration — a category error that breaks provenance, trust, and recall.
2. **Trigger model.** RESEARCH is request/topic-driven (`research-request` with
   `what/why/context/dedupKey`, dispatcher eligibility + self-nomination). INTAKE has no
   topic question — its trigger is "a new item exists in a subscribed feed." Forcing a
   synthetic `research-request` per feed item is contortion.
3. **Egress story.** RESEARCH egress is the open world about a topic, gated by tier and built
   only from the request (D6a). INTAKE never builds an outbound query from KB content — it
   does authenticated reads of the Principal's *own* feeds (a strictly *cleaner* egress
   posture). Collapsing them muddies a model RESEARCH spent its whole security design on.
4. **Downstream contract.** RESEARCH findings corroborate (conflict→Review). INTAKE items are
   the **input** that seeds topics, not corroboration of them.

**Shared substrate, separate specs.** INTAKE reuses: the SPEC-0023 scheduler/journal/
single-flight/promotion; the SPEC-0008 Ingest spine; and the SPEC-0028 connector auth model
(BYOA, M365 OAuth-MCP, read-only world). It adds only: the *pull-as-primary* surface, the
*subscription* trigger, and *recurring-item dedup*.

## 4. User flows / feature surface

**Primary flow — subscribe a feed:**
1. Control Panel → Sources → **Add intake connector** → pick a template (RSS / M365 mail;
   M365 calendar arrives in Slice 2).
2. Configure: feed URL (RSS) or tenant + mail folder/query (M365 mail); **scope + sensitivity
   defaults**; **cadence** (JOBS preset: a few times/day · hourly · daily · off); an initial
   **backfill window**; enable.
3. **Run now** to test → the connector pulls new items → each is archived as a primary source
   and shows in the last-run summary ("Brought in N").
4. On cadence thereafter, the `intake` job fires, pulls items new since its cursor, and feeds
   each through Ingest → Enrich. Already-seen items are skipped (dedup).

**Secondary / edge flows:**
- **First connect / backfill:** a bounded initial window (default: "from now"; Principal may
  widen) so a new connector does not pull years of history in one pass.
- **Auth expiry (M365):** an expired OAuth token surfaces a Review/notify ("reconnect M365"),
  does not crash the job, and loses no already-archived items.
- **Feed unreachable / fetch error:** the pass degrades gracefully — already-archived items
  stay preserved; the failure is audited and surfaced; the cursor is not advanced past
  unfetched items (INTAKE-12).
- **Item revised upstream** (e.g. an RSS item is edited under the same GUID): the new snapshot
  arrives as a new immutable primary source (append-only), deduped on `external-id +
  last-modified`. (Calendar's richer move/cancel semantics are a Slice-2 concern.)

## 5. Requirements

| ID         | Priority | Statement (short)                                                                 | Verify   | Traces |
| ---------- | -------- | --------------------------------------------------------------------------------- | -------- | ------ |
| INTAKE-1   | must     | INTAKE is a **scheduled outbound pull** of external feeds into the KB as **primary sources**, running as an `intake` **job type** on the SPEC-0023 JobScheduler | none-yet | VISION-7; LIFE-1; JOBS-2 |
| INTAKE-2   | must     | **Boundary vs RESEARCH:** INTAKE produces **primary** sources (subscription/time-driven, the item itself); RESEARCH produces **secondary** cited sources (request/topic-driven corroboration). The test: an item is INTAKE iff it enters as a primary source the KB is built on, **not** a citation about an existing topic | none-yet | DATA-1,2; RESEARCH-5 |
| INTAKE-3   | must     | Every pulled item flows through the **SPEC-0008 Ingest spine** (archive immutable primary source + commit **before** processing → classify → catalog → enqueue Enrich); INTAKE is an **arrival surface**, not a new pipeline, and does not reimplement preservation | none-yet | INGEST-1,2,6; LIFE-2 |
| INTAKE-4   | must     | A **connector registry** records each subscription as a per-vault job `{id, type, schedule, enabled, config}` with a typed per-template `config` block; the Principal enables/disables and sets cadence | none-yet | JOBS-1,14; VISION-11 |
| INTAKE-5   | must     | **Connector set v1 (Slice 1)** ships **RSS/Atom** (public, no-auth) and **M365 mail** (internal-tenant, reusing the SPEC-0028 M365 OAuth-MCP substrate); **M365 calendar is Slice 2** (mutable-event semantics); the connector core is **generic** so further templates are additive | none-yet | RESEARCH-16; VISION-7 |
| INTAKE-6   | must     | **BYOA / no stored secrets:** INTAKE authenticates exactly as RESEARCH-9 (M365 MCP OAuth, owned by the main process, never in the renderer, redacted in logs; RSS is unauthenticated public). **KB-App stores no credentials.** A connector that cannot authenticate without app-managed secrets **does not ship** | none-yet | RESEARCH-9; AUTO-11; PRIN-19 |
| INTAKE-7   | must     | **Read-only w.r.t. the world** (AUTO-6): INTAKE only **reads/polls** feeds; it **MUST NOT** mutate the remote — no mark-as-read, no delete, no send, no RSVP, no ack. The **only** state it keeps is its own **local** cursor + dedup ledger | none-yet | AUTO-6; RESEARCH-10 |
| INTAKE-8   | must     | **Recurring-item dedup / idempotency:** a durable per-connector **cursor + dedup ledger** keyed on the feed's **stable external item ID** (RSS GUID / RFC-5322 Message-ID / Graph item id), **content-hash fallback**; a previously-ingested item is **never re-archived**. Ledger lives in the connector's per-job journal (`.kb/jobs/<job>/journal.jsonl`), versioned on `staging`, **never promoted** | none-yet | JOBS-7; INGEST(open-q: dedup) |
| INTAKE-9   | must     | **Connector-default classification:** each connector carries default **scope + sensitivity** (SCOPE-14), applied to its items as a high-confidence signal at ingestion; conservative default `internal`; **uncertain → Review** | none-yet | SCOPE-8,9,14; INGEST-4 |
| INTAKE-10  | must     | **Provenance:** each primary source records **connector identity, external item ID/URL, fetch timestamp, and original feed metadata**; the original artifact is preserved immutably (INGEST-3) | none-yet | INGEST-3; DATA-5,10 |
| INTAKE-11  | must     | An INTAKE pass is **bounded** (capped items + cost/time budget per pass — no unbounded feed drain), **single-flight** per connector, and runs **concurrently** off a synced checkpoint, inheriting the JOBS contract | none-yet | JOBS-4,5,6 |
| INTAKE-12  | must     | **Failure never loses data + disposition:** routine scheduled ingestion is **silent** (reversible, audited); a fetch/auth failure leaves **already-archived items durably preserved**, does **not** advance the cursor past unfetched items, and is **surfaced** (notify) or **flagged → Review** (e.g. reconnect M365); uncertain classification → Review (approve-first) | none-yet | AUTO-7; INGEST-8,9 |
| INTAKE-13  | must     | **Untrusted-content posture for open feeds:** RSS/news content is **open-world** — even though the item enters as a *primary* source, its content is treated as **DATA, never instructions** downstream (the same prompt-injection defense as RESEARCH-12), because automated open-web pull is a higher injection surface than manual capture. M365 mail/calendar is internal-tenant | none-yet | RESEARCH-12; PRIN-19,20 |
| INTAKE-14  | should   | INTAKE connectors are **managed in the Control Panel** (a Sources/Intake surface): add-from-template, configure (schedule, scope/sensitivity defaults, feed/auth config, backfill window), enable/disable, **run-now**, and see **last-run + items-ingested + errors**. Run-now is also a test affordance (JOBS-11) | none-yet | PANEL-1; JOBS-11,14; VISION-11 |
| INTAKE-15  | should   | **One primary source per feed item** (not a digest): each mail/article/event becomes its own source, preserving per-item provenance + dedup granularity. Digesting/summarizing across items is a downstream **synthesis (Output)** concern, not ingestion | none-yet | DATA-1,2; INGEST-5 |
| INTAKE-16  | must     | **Delete a connector (lifecycle parity, PANEL-11).** An intake connector (feed) can be **removed** from the Sources view (confirm-gated), mirroring the watch-folder delete (`removeActiveWatchFolder`): the connector config is **purged** + its schedule torn down + the removal **audited**; **already-ingested sources remain** in the KB. *Today only disable exists — no delete at the registry/IPC/view layer.* | none-yet | PANEL-11; DATA-2; AUDIT-11 |

### INTAKE-2 — The boundary vs RESEARCH
- **Status:** draft · **Priority:** must
- **Statement:** INTAKE produces **primary** sources on a **subscription/time** trigger;
  RESEARCH produces **secondary, cited** sources on a **request/topic** trigger. The
  classification test is the one-axis test in §3: an item belongs to INTAKE iff it enters as
  a primary source the KB is built on, not a citation corroborating an existing topic.
- **Rationale:** This is the must-resolve fork. The source model (DATA-1/2) splits primary
  from secondary along a deep trust/mutability invariant; routing the Principal's own
  subscribed feeds through RESEARCH would mislabel them as untrusted corroboration. Keeping
  the specs separate over a shared substrate preserves the ontology while avoiding duplication.
- **Traces:** DATA-1, DATA-2, RESEARCH-5
- **Verify:** none-yet

### INTAKE-7 — Read-only w.r.t. the world
- **Status:** draft · **Priority:** must
- **Statement:** INTAKE polls/reads feeds only and **MUST NOT** cause any remote side effect —
  in particular it MUST NOT mark mail read, delete, send, RSVP, or acknowledge. The only state
  it persists is a local cursor + dedup ledger.
- **Rationale:** AUTO-6 ("the KB is read-only w.r.t. the world") and RESEARCH-10. A naive mail
  poll that marks messages read *is* a side effect the Principal would notice; calling it out
  prevents a subtle violation hiding in an otherwise-innocent "fetch."
- **Traces:** AUTO-6, RESEARCH-10
- **Verify:** none-yet

### INTAKE-8 — Recurring-item dedup / idempotency
- **Status:** draft · **Priority:** must
- **Statement:** A durable per-connector cursor + dedup ledger, keyed on the feed's stable
  external item ID (content-hash fallback), guarantees a previously-ingested item is never
  re-archived; an updated item arrives as a **new** immutable snapshot deduped on
  `external-id + last-modified`. The ledger lives at `.kb/jobs/<job>/journal.jsonl`
  (versioned on `staging`, never promoted, hidden from Obsidian).
- **Rationale:** Feeds re-serve items every poll (RSS re-lists, mail/calendar re-sync). Without
  durable dedup, every cadence tick would re-archive the whole feed — flooding the KB and
  destroying the append-only source model. Reuses the JOBS-7 journal location so no new
  storage/gitignore surface is introduced.
- **Traces:** JOBS-7; SPEC-0008 open question (dedup / re-ingestion)
- **Verify:** none-yet

## 6. Reuse map (what INTAKE composes, not rebuilds)

- **SPEC-0023 JOBS** — registry shape, named-preset scheduler, single-flight, concurrency,
  per-job journal, promotion gate, run-now, autonomy posture. INTAKE is the `intake` job type.
- **SPEC-0008 INGEST** — archive→classify→catalog→enqueue. INTAKE produces ingestion requests.
- **SPEC-0028 RESEARCH** — the **connector/auth substrate** only: M365 OAuth-MCP (BYOA,
  main-process-owned, tenant-allowlisted, read-only), the untrusted-content-as-data posture.
- **SPEC-0005 SCOPE** — connector default scope/sensitivity (SCOPE-14), uncertain→Review.
- **SPEC-0027 PANEL** — the management surface.

## 7. Forks & recommendations (for KB-Lead product review)

**F1 — Boundary vs RESEARCH (the must-resolve).** → **RECOMMEND: separate specs, shared
substrate** (do not fold). Distinguished by source kind (primary vs secondary) + trigger
(subscription vs request/topic), per §3. *Confidence: high — folding breaks DATA-1/2.*

**F2 — Connector set v1.** → **RESOLVED (KB-Lead product ruling, 2026-06-06): Slice 1 = RSS/Atom
+ M365 mail; M365 calendar → Slice 2; defer raw IMAP/CalDAV.** Rationale: RSS is public/no-auth
(lowest risk, easiest to live-validate) and M365 reuses the *already-designed* OAuth-MCP BYOA
substrate. **M365 calendar is deferred** because mutable-event-snapshot semantics (events
move/cancel → new source vs. update vs. contradiction) add real complexity that would muddy a
clean v1. **Raw IMAP/CalDAV need username+password or app-passwords → an app-managed secret
store, which RESEARCH-9/AUTO-11 forbid** ("KB-App stores no secrets"); they ship only if/when a
BYOA-compatible auth path exists (e.g. OAuth-IMAP via the provider).

**F3 — Recurring-item dedup.** → **RECOMMEND: durable per-connector cursor + stable-external-ID
ledger (content-hash fallback) in the JOBS journal** (INTAKE-8). Reuses existing storage; no
new gitignore surface. *Confidence: high.*

**F4 — BYOA auth.** → **RECOMMEND: inherit RESEARCH-9 verbatim** — no stored secrets, M365 via
OAuth-MCP owned by the main process, RSS unauthenticated. A connector that can't meet this
doesn't ship (ties F2). *Confidence: high.*

**F5 — Read-only invariant.** → **RECOMMEND: strict — no remote mutation at all, incl.
mark-as-read** (INTAKE-7). The only persisted state is the local cursor/ledger. *Confidence:
high.*

## 8. Open questions

- [x] **Exact v1 connector cut** — RESOLVED (KB-Lead, 2026-06-06): **Slice 1 = RSS + M365-mail;
      M365 calendar → Slice 2** (mutable-event-snapshot semantics).
- [ ] **Backfill window default** — "from now" (recommended, safest) vs a bounded lookback;
      and per-connector configurability.
- [ ] **Large/binary enclosures** (podcast audio, PDF attachments) — store in-vault vs
      pointer + extracted text. **Defer to the shared SPEC-0008 open question** (same concern,
      same answer); INTAKE should not fork it.
- [ ] **Calendar event identity (Slice 2)** — deferred with the calendar connector: dedup key
      `event-id + last-modified`, and whether a moved/cancelled event is a new append-only
      snapshot vs. a contradiction (SPEC-0036). Resolve when Slice 2 is specced.
- [ ] **Cadence floor** — JOBS named presets (few-times/day/hourly/daily) — is hourly fine for
      mail, or does any feed need finer? (Likely fine; raw-cron is the JOBS-2 escape hatch.)
- [ ] **Per-connector autonomy posture** — INTAKE is additive/reversible (Guarded default,
      JOBS-15) so silent ingestion is safe; confirm no INTAKE action needs approve-first beyond
      uncertain-classification→Review (INTAKE-9/12).

## 9. Changelog

- 2026-06-06 — **product review (KB-Lead): APPROVED, both forks ratified.** F1 (boundary vs
  RESEARCH) ratified — separate specs over a shared substrate, primary-vs-secondary is the
  correct invariant. F2 ratified with a refinement: **Slice 1 = RSS + M365-mail; M365 calendar
  → Slice 2** (mutable-event-snapshot semantics), raw IMAP/CalDAV stay deferred on the
  no-stored-secret rule. Renumbered SPEC-0037 → **SPEC-0041** per the PM allocation of record
  (0037 = WATCH). Scope/INTAKE-5/F2/§8 updated to mail-only v1.
- 2026-06-06 — created (draft). **Proactive Intake** modeled as an **arrival surface** that
  composes SPEC-0023 JOBS (scheduler, as an `intake` job type) + SPEC-0008 INGEST (preserve
  spine) + the SPEC-0028 connector/BYOA substrate, producing **primary** sources. **Must-resolve
  fork F1 (boundary vs RESEARCH) resolved: separate specs over a shared substrate** —
  distinguished by source kind (primary vs secondary) and trigger (subscription vs
  request/topic), with the scheduled-M365-mail collision resolved by *subscribe-as-primary*
  (INTAKE) vs *query-for-a-findings-note* (RESEARCH). Recommendations on connector set (RSS +
  M365; defer IMAP/CalDAV on the no-stored-secret invariant), dedup (durable cursor + stable-ID
  ledger in the JOBS journal), BYOA (inherit RESEARCH-9), and read-only (strict, incl. no
  mark-as-read). No implementation — spec lock first.
