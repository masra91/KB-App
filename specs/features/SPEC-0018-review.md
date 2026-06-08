---
spec: SPEC-0018
key: REVIEW
title: Review & Disambiguation (the "needs you" queue)
type: feature
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-31
updated: 2026-05-31
related: [SPEC-0004, SPEC-0005, SPEC-0006, SPEC-0007, SPEC-0013, SPEC-0014, SPEC-0016, SPEC-0017]
supersedes: null
stage: Review
---

# Review & Disambiguation (the "needs you" queue)

> A way for **any agent, at any stage, in any flow** to stop and ask the Principal a
> **single yes/no question with context** instead of guessing — and to **resume that
> exact piece of work** once answered. The first concrete build of the "needs you" queue
> (AUTO-10) and the Review lifecycle stage (LIFE-6/7): escalations and the Principal's
> answers become part of the record, and answer-notes become **primary sources**.

## 1. Intent (the why / JTBD)

The KB's core promise is *grounded* knowledge that "asks rather than assumes" (SPEC-0004
Stage 5; PRIN). Today our thin agents must either guess or drop a passive `signal` into
the audit log that no human ever has to act on. Neither resolves genuine ambiguity:
*"is this Steve the same Steve as last week?"*, *"is this topic sensitive enough that I
should not research it?"*. The librarian needs a **blocking, answerable escalation** and
a way to **continue once you answer**.

SPEC-0006 already promised the surface — **AUTO-10**: *"approve-first items & Review
escalations surface in a shared 'needs you' queue."* SPEC-0004 already promised the
semantics — **LIFE-6** (route uncertainty to Review) and **LIFE-7** (*"Review escalations
AND the Principal's responses are stored as primary sources"*). This spec **builds** them:
the durable review artifact, the raise/park/resume mechanism on the SPEC-0014 harness, the
note-as-source path, and the **Reviews view** in the navigation shell (SPEC-0017).

The payoff: agents stop guessing on the things that matter, you answer a tight yes/no with
enough context to be confident, and the answer both **unblocks the waiting work** and
**feeds the KB** — so the system gets more right over time with minimal demand on you.

### 1.1 Vocabulary — Signal vs. Review (read this first)

Both are an agent putting something on the record; they differ on **who must act**:

| | **Signal** (SPEC-0016 §3.3) | **Review** (this spec) |
| --- | --- | --- |
| Destination | audit log only | the **`reviews/` queue** + audit |
| Human action | none required — a breadcrumb | **required** — you answer yes/no |
| Effect on the flow | none (non-blocking) | **parks that work item** until answered |
| Shape | `{type, note, refs?}` (open) | **boolean question + context**, answer `confirm|reject` (+ note) |
| Examples | "coined kind 'site'"; "possible dup" | "is this Steve, Steve Jones?"; "may I research this topic?" |

A review is the **escalation** a signal is not: it blocks the specific item and demands a
decision. (A future Reflect/Connect stage may *promote* certain signals into reviews; v1
agents raise reviews directly.)

## 2. Scope

**In scope (the v1 vertical slice — demonstrated end-to-end via Claims):**
- A **review artifact**: `reviews/<ULID>/review.json`, git-backed, `open → answered`,
  carrying the question, agent context, provenance (raising stage/agent/run + subject
  refs), and the resume target.
- The **boolean-question contract**: a review is a yes/no question; the answer is
  `confirm | reject` plus an **optional free-text note**. Not open-ended.
- Agent **context**: a one-line `question` + an expandable `detail` (a paragraph / how-it-
  was-used snippets) so the Principal knows *why the agent cares* and *what they confirm*.
- The **raise channel**: a `reviews[]` field on the thin-agent decision (alongside
  `signals[]`), so any harness stage can raise one (ORCH-7). v1 wires it into **Claims**.
- **Per-item park** (REVIEW-5): raising a review parks **only that work item**; the stage
  keeps draining every other item.
- **Resume on verdict** (REVIEW-6): answering re-enqueues the parked item and re-runs it
  with the answer available; **the verdict alone resumes** (it does not wait on note
  propagation). The re-run may raise a **follow-up review** (cascade, REVIEW-8).
- **Note → primary source** (REVIEW-7): an answer-note is captured as a primary Source
  (origin: principal) via Ingest, linked from the review, and propagates through Enrich
  **independently** of the resume.
- The **Reviews view** in the shell (SPEC-0017): list open reviews, expandable context,
  confirm/reject + optional note; a typed IPC pair (`listReviews` / `answerReview`).

**Out of scope (for now):**
- **Batched notifications** (dock badge / tray) — AUTO-10 mentions them; deferred (the
  derived queue + view is the v1 surface).
- **Approve-first / risk-disposition routing** (AUTO-7): the *other* feeder of the shared
  queue (irreversible/high-risk actions auto-raising). v1 builds the **ambiguity/Review**
  feeder; the queue is shaped to carry approve-first items later with no change.
- **Review of non-stage flows** (e.g. a Query/Ask answer asking to confirm) — same
  mechanism, but v1 only wires the Enrich stages.
- **Rich threading / multi-question reviews** — every review is exactly one yes/no; a chain
  is modeled as a **cascade of single reviews** (REVIEW-8), not a multi-part form.
- **Reopening / editing an answered review** — answers are append-only; a mistake is
  corrected by the propagation of a new note-source or a follow-up review, not by editing.

## 3. The mechanism (raise → park → answer → resume)

Reviews ride the **same SPEC-0014 harness** as Decompose/Claims; the only new engine
concept is a **non-terminal park state** for a work item.

```
[STAGE AGENT] (e.g. Claims, thin/cognition-only) returns a decision that includes
   reviews[]: [{ question, detail, refs? }]            (a yes/no + context; ORCH-7)
   │
   ▼
ORCHESTRATOR (deterministic effects):
   ├─ write reviews/<R>/review.json  (status: open; raisedBy: stage/run; subject; resume target)
   ├─ append audit `review-raised` (envelope) to the item's audit.jsonl
   ├─ mark the item `awaiting-review` (a NON-terminal park marker, keyed to the item)
   │     → the stage's derived queue SKIPS just this item; all other items keep draining (REVIEW-5)
   └─ commit; ff-advance canonical
   ┊
   ┊   …the "needs you" queue = open reviews. Surfaced in the Reviews view (SPEC-0017).
   ▼
PRINCIPAL answers in the Reviews view → IPC answerReview(id, {verdict, note?}):
   ├─ write answer onto reviews/<R>/review.json  (status: answered; verdict; answeredAt)
   ├─ if note: captureToInbox(note) → a NEW primary source (origin: principal; SPEC-0013) —
   │     linked from the review; it propagates through Decompose/Claims on its own (REVIEW-7)
   ├─ append audit `review-answered` (verdict + note) to the parked item's audit.jsonl
   │     → this SUPERSEDES `awaiting-review`: the item re-enters the derived queue (REVIEW-6)
   └─ commit; ff-advance; poke the stage
   ▼
STAGE RE-RUNS the unparked item — the agent now sees the answered review(s) as context and
   re-decides. It may resolve cleanly, OR raise a FOLLOW-UP review (cascade; REVIEW-8).
   A per-item review-round cap (like maxAttempts) bounds runaway cascades.
```

### 3.1 The review request (what the agent emits)

Part of the decision, alongside `signals[]`. The agent writes nothing; the orchestrator
mints the review id and does all effects.

```json
{
  "question": "Is the ‘Steve’ in this source the same as Steve Jones?",
  "detail": "This source says ‘Steve approved the Q3 budget’. An earlier source has a Steve Jones who owns budgets. They may be the same person; confirming lets me attribute the budget claim correctly rather than create a second Steve.",
  "refs": ["Steve", "Steve Jones"]
}
```

- **`question`** (required) — a single **yes/no** question. Validation does not parse
  English, but the contract (and the prompt) require a confirmable assertion, never an
  open-ended one ("who is Steve" is wrong; "is Steve here Steve Jones" is right).
- **`detail`** (required) — the expandable context: why the agent cares, how the subject
  was used, what a confirm/reject means. Rendered click-to-expand in the view.
- **`refs[]`** (optional) — entity names / mentions the question is about.

### 3.2 The review artifact (what the orchestrator writes)

`reviews/<dateShard(id)>/<id>/review.json`, orchestrator-authored. A **workflow artifact**,
not KB knowledge — it is the durable "needs you" item, so it is stored as **canonical JSON**
the app reads directly (no hand-rolled YAML parser; ENG simplicity), *not* Obsidian-native
markdown. The only thing that enters the three-kinds model from a review is the
**answer-note**, which becomes a Source (§3.4).

```json
{
  "id": "01JREV…",
  "status": "open",
  "question": "Is the ‘Steve’ in this source the same as Steve Jones?",
  "detail": "This source says ‘Steve approved the Q3 budget’… (the agent's context).",
  "raisedBy": {
    "stage": "claims",
    "runId": "01J…",
    "item": { "kind": "entity", "ref": "entities/2026/05/31/01JENT.md" },
    "auditRel": "sources/2026/05/31/01JSRC/audit.jsonl",
    "markerKey": { "entityId": "01JENT" }
  },
  "subject": { "refs": ["Steve", "Steve Jones"], "sources": ["sources/2026/05/31/01JSRC"] },
  "createdAt": "2026-05-31T18:00:00Z",
  "answer": {
    "verdict": "reject",
    "note": "It's Steve Lin, not Jones.",
    "noteSourceId": "01JNOTE…",
    "answeredAt": "2026-05-31T18:05:00Z"
  }
}
```

- `raisedBy.auditRel` + `markerKey` let the answer path **supersede the park** generically —
  it appends a `review-answered` marker to the parked item's audit without knowing the
  stage's internals (§3.3).
- `answer` is absent while `status: open`; it is added on resolution. The `note` (optional)
  is also captured as a primary source — `noteSourceId` links it (§3.4).
- The agent's `detail` is the expandable context the Reviews view renders (e.g. "This source
  says 'Steve approved the Q3 budget'. An earlier source has a Steve Jones who owns budgets…").

### 3.3 Per-item park & resume (the one engine addition)

The harness already has per-item terminal markers (`claimed`/`setaside` etc.). Review adds
a **non-terminal** marker:

- **`awaiting-review`** (keyed to the work item) — the item is parked: the stage's derived
  queue **skips it** but it is **not done**. Other items drain normally (REVIEW-5).
- **`review-answered`** (carrying `reviewId`, `verdict`, and the note text) — supersedes the
  park: the item re-enters the queue and re-runs (REVIEW-6). The re-run reads any
  answered-but-unconsumed reviews for the item and feeds them to the agent as context.
- The verdict is sufficient to resume; the note's **propagation as a source is
  independent** and asynchronous (REVIEW-7) — the re-run never blocks on it.
- **Idempotent/restartable** (REVIEW-13): park and answer states are committed audit, so a
  crash/restart resumes from them exactly like every other harness state.
- **Cascade cap**: a per-item `review-round` count bounds runaway re-asking; past the cap
  the item is set aside (preserved, flagged) rather than looping forever.

### 3.4 The answer-note as a primary source (LIFE-7)

When the Principal adds a note, the orchestrator routes it through the **existing Ingest
path** (`captureToInbox`, SPEC-0013) as a **primary source** with `origin: principal`,
tagged as a review response and linked from the review (`answer.noteSource`). It is then a
normal source: Decompose/Claims process it on their own schedule, so the correction ("it's
Steve Lin") enters the graph as grounded knowledge and may itself trigger further change.
This is the literal build of LIFE-7 ("responses become primary source material") and reuses
Ingest rather than inventing a second write path.

### 3.5 The Reviews view (SPEC-0017 shell)

A new view registered in the navigation shell (one entry, no edits to existing views —
SHELL-5):
- **List** of open reviews (the "needs you" queue), newest first, each showing the
  one-line `question` and its origin.
- **Expandable context** — click to reveal the full `detail` (REVIEW-3).
- **Confirm / Reject** buttons; on either, an **optional note** field (the Principal adds a
  correction on reject, or extra context on confirm).
- Answering calls IPC `answerReview(id, {verdict, note?})`; the list refreshes (the item
  leaves the queue). The renderer stays a thin layer over typed IPC (STACK-2/6; REVIEW-11).

## 4. Requirements

| ID         | Priority | Statement (short)                                                  | Verify   | Traces |
| ---------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| REVIEW-1   | must     | Any harness stage can **raise a review** — a yes/no question + context — surfaced in the shared "needs you" queue | test:claimsStage.test.ts | AUTO-10; LIFE-6 |
| REVIEW-2   | must     | A review is a **boolean** question; the answer is `confirm | reject` plus an **optional note** — never open-ended | test:reviews.test.ts | LIFE-6; PRIN-4 |
| REVIEW-3   | must     | A review carries agent **context**: a one-line `question` + an expandable `detail` (why it cares / what a verdict means) | test:reviews.test.ts, claims.test.ts | LIFE-6; AUTO-8 |
| REVIEW-4   | must     | Reviews are first-class **git-backed artifacts** in `reviews/` (`open → answered`) with provenance (raising stage/run + subject) | test:claimsStage.test.ts | DATA-9,10; LIFE-9 |
| REVIEW-5   | must     | Raising a review **parks only the raising work item** (non-terminal marker); every other item in the stage keeps draining | test:claimsStage.test.ts | ORCH-6; LIFE-6 |
| REVIEW-6   | must     | Answering (`confirm`/`reject`) **resumes** the parked item — re-runs it with the answer as context; **the verdict alone resumes** (no wait on note propagation) | test:claimsStage.test.ts | LIFE-6; ORCH-13 |
| REVIEW-7   | must     | An answer **note is captured as a primary Source** (origin: principal) via Ingest, linked from the review, and propagates through Enrich **independently** of the resume | test:claimsStage.test.ts | LIFE-7; DATA-2 |
| REVIEW-8   | must     | A resumed re-run **may raise a follow-up review** (cascade) by the same mechanism; a per-item round cap bounds runaway cascades | test:claimsStage.test.ts | LIFE-6; ORCH-12 |
| REVIEW-9   | must     | The full review lifecycle (raised, answered, verdict, note) is **audited**; the queue is a **derived view** over open reviews, not a parallel notifier | test:claimsStage.test.ts | AUTO-8,10; DATA-10 |
| REVIEW-10  | must     | A **Reviews view** in the shell lists open reviews with **expandable context** and **confirm/reject + optional note**; added by one registration (no edits to existing views) | test:app/src/shell/navModel.test.ts | SHELL-5; AUTO-10 |
| REVIEW-11  | must     | Reviews surface via the **typed IPC contract** (`listReviews`/`answerReview`); the main process owns the store, the renderer stays thin | test:claimsStage.test.ts | STACK-2,6; SHELL-6 |
| REVIEW-12  | must     | Reviews and answers **never mutate sources or prior derived identity**; the review artifact + note-source are purely additive | test:claimsStage.test.ts | DATA-2; LIFE-2 |
| REVIEW-13  | should   | Park/resume is **idempotent / restartable** on the harness: a parked item stays parked across restart; an answered one re-enters the queue exactly once | test:claimsStage.test.ts | ORCH-4,13 |
| REVIEW-14  | should   | The agent raises a review via the **decision channel** (`reviews[]`), so any thin-agent stage gains it with no bespoke wiring; v1 demonstrates via Claims | test:claims.test.ts, claimsAgent.test.ts | ORCH-7; AUTO-2 |
| REVIEW-15  | may      | Open reviews drive **batched notifications** (dock/tray) — deferred; the derived queue + view is the v1 surface | none-yet | AUTO-10 |
| REVIEW-16  | must     | **A disambiguation review carries decision-grade per-candidate context + working links** — bare names are not enough to decide. For a "same entity?" / "are these related?" review (CONNECT-15), each candidate MUST carry a **human distinguishing gloss** — what makes *this* one this one (its source context / strongest claim / timeframe), e.g. *"Benton — from the fishing-trip notes (May 2026)"* vs *"Benton — Dave's wedding guest list"* — **authored by the raising agent** (which has both sources' content in hand), and the **`question` itself uses the glosses**, not bare names. Each candidate also carries a **working click-to-open-in-Obsidian link** to its source/note (reuse the established `kb:openCitation` / `obsidianOpenUri` affordance EXPLORE already uses) so the Principal can dig in for more context before answering. The Reviews view (REVIEW-10) renders each candidate as a row: **gloss + open-link** (no longer plain non-clickable text). *(Today the review carries only `subject.refs` bare names — `connectStage.ts` — rendered as plain text in `reviewsView.ts`; the Principal can't tell the candidates apart or open them.)* | none-yet | REVIEW-3,10; CONNECT-15; SPEC-0039; SPEC-0031 |

### REVIEW-2 — Boolean questions only
- **Status:** draft · **Priority:** must
- **Statement:** A review **MUST** be a single yes/no question answerable as
  `confirm | reject`, with an optional free-text note. It **MUST NOT** be an open-ended
  prompt. Disambiguation that needs more than yes/no **MUST** be modeled as a **cascade**
  of boolean reviews (REVIEW-8), not a multi-part question.
- **Rationale:** A boolean is the cheapest possible demand on the Principal and keeps the
  answer machine-actionable for resume. "Who is Steve?" forces the human to do the agent's
  job; "is Steve here Steve Jones?" lets them confirm in one click — and a `reject` with a
  note ("it's Steve Lin") gives the correction without an open form.
- **Traces:** LIFE-6, PRIN-4
- **Verify:** none-yet

### REVIEW-5 — Park the item, not the stage
- **Status:** draft · **Priority:** must
- **Statement:** Raising a review **MUST** park only the specific work item that raised it
  (a non-terminal `awaiting-review` marker keyed to that item); the stage **MUST** continue
  draining all other items. The parked item **MUST NOT** be treated as failed or done.
- **Rationale:** The Principal's call: one ambiguous entity must not stall the whole
  pipeline. Per-item parking falls out of the existing derived-queue model — a skip state
  distinct from terminal `claimed`/`setaside`.
- **Traces:** ORCH-6, LIFE-6
- **Verify:** none-yet

### REVIEW-6 — Verdict resumes; note propagation is independent
- **Status:** draft · **Priority:** must
- **Statement:** Answering **MUST** re-enqueue the parked item and re-run it with the
  answered review(s) available as context. The **verdict alone MUST be sufficient** to
  resume — the resume **MUST NOT** block on the answer-note being captured, decomposed, or
  claimed. The note's effects arrive later via normal Enrich propagation (REVIEW-7).
- **Rationale:** The Principal's call: "at least the confirm/deny portion should allow
  continue." Unblocking on the boolean keeps the loop tight; the note enriches the KB on
  its own timeline and may change things afterward, which is acceptable and expected.
- **Traces:** LIFE-6, ORCH-13
- **Verify:** none-yet

### REVIEW-7 — The note is a primary source
- **Status:** draft · **Priority:** must
- **Statement:** If the Principal adds a note, the orchestrator **MUST** capture it as a
  **primary Source** (origin: principal) through the existing Ingest path, link it from the
  review (`answer.noteSource`), and let it propagate through Decompose/Claims like any
  source. The note **MUST NOT** be written into the KB graph directly by the Review code.
- **Rationale:** LIFE-7 verbatim — responses become primary source material. Reusing Ingest
  keeps one preservation path and makes the correction first-class, replayable knowledge.
- **Traces:** LIFE-7, DATA-2
- **Verify:** none-yet

### REVIEW-12 — Additive, never mutating
- **Status:** draft · **Priority:** must
- **Statement:** Raising or answering a review **MUST NOT** edit, move, or delete any
  source or the identity of any prior derived node; it only writes the `reviews/` artifact,
  the item's append-only audit markers, and (on a note) a new source.
- **Rationale:** Immutability + provenance are the trust model (DATA-2); the review queue is
  additive workflow state layered over an unchanged ground truth.
- **Traces:** DATA-2, LIFE-2
- **Verify:** none-yet

## 5. Concurrency & failure model (v1 posture)

Inherits SPEC-0014 §5 / SPEC-0016 §5:
- **Serial within a stage**, pipelined across stages; the canonical advance is serialized
  through the shared writer lock. Writing a review + park marker, and answering, are
  ordinary committed effects through that lock.
- **Per-item containment** — a parked item never blocks others (REVIEW-5); an answer affects
  only its item; a poison item (cascade past the cap, or a malformed review request) is set
  aside, never lost (ORCH-12).
- **Answer races** — answering is idempotent: a second answer to an already-answered review
  is a no-op (the artifact + audit already record `answered`).
- **Restart** — park/answer/round-count are committed audit, so the loop resumes from them
  (REVIEW-13). The note-source, once captured + committed by Ingest, propagates regardless
  of the review's later state.

## 6. Where this sits / hands off

- **Feeds on:** any thin-agent stage (v1: Claims) raising `reviews[]`. The same channel will
  let Decompose, Connect, Research, and Ask raise reviews unchanged (REVIEW-14).
- **Feeds:** the **Ingest** spine (answer-notes as sources, REVIEW-7), which feeds Enrich —
  so an answer can ripple into new entities/claims and even new reviews.
- **Shares the queue with:** approve-first / risk dispositions (AUTO-7), the *other* AUTO-10
  feeder — deferred, but the artifact + view are shaped to carry them (a `kind: approval`
  review with the same confirm/reject shape) with no redesign.
- **Surfaced by:** the navigation shell (SPEC-0017) as the Reviews view; later a richer
  Control Panel (`PANEL`) may host it.

## 7. Open questions

- [x] **`reviews/` physical layout** *(architecture)* — *resolved:* `reviews/<dateShard(id)>/
      <id>/review.json` — a per-review **directory** (room for future attachments) holding a
      canonical **JSON** record. JSON (not markdown frontmatter) because a review is workflow
      state the app reads, not Obsidian-native knowledge — avoids a bespoke YAML parser.
- [ ] **Cascade round cap** — how many follow-up reviews on one item before set-aside? A
      small constant (parallels Decompose/Claims `maxAttempts`); tune on observed behavior.
- [ ] **Stale parks** — if an entity's source is superseded/replayed while a review is open,
      is the open review auto-closed, or left for the Principal? (Revisit with Replay.)
- [ ] **Surfacing the parked item's resumed result** — after resume, does the view show
      "resolved" feedback, or is it silent (the queue just shrinks)? v1: silent (queue
      shrinks); a future activity feed (AUTO-9) is the natural home for "what your answer did".
- [ ] **Approve-first reviews** — when AUTO-7 dispositions land, do they share `review.json`
      with a `kind` discriminator, or get their own artifact? (Leaning: shared shape.)
- [ ] **Question quality** — is a non-boolean question caught only by prompt guidance, or
      should a Reflect pass flag/repair malformed reviews? (v1: prompt + shape only.)

## 8. Changelog

- 2026-06-08 — **REVIEW-16: disambiguation reviews get decision-grade per-candidate context + working
  links** (Principal). The "are these two the same?" review (the elevated coalesce/merge review) asked the
  Principal to decide with only **bare candidate names** (`subject.refs`, rendered as plain non-clickable
  text) — no way to tell the two apart, no way to open them. REVIEW-16: each candidate carries an
  **agent-authored distinguishing gloss** ("Benton — from the fishing trip" vs "Benton — Dave's wedding"),
  the **question uses the glosses**, and each candidate gets a **working open-in-Obsidian link** (reusing
  the existing `kb:openCitation`/`obsidianOpenUri` affordance from EXPLORE). **Good news for impl:** the
  Obsidian-open machinery already exists and the distinguishing context already exists on the candidates
  (`sourceId` + verbatim `mentions`) — it just doesn't flow into the review. Two-part dispatch: dev enriches
  the Connect→Review payload (`connectStage.ts` populates per-candidate context + the agent prompt asks for
  the gloss); Design-Lead renders the candidate rows + links in `reviewsView.ts`.
- 2026-05-31 — created (draft). Builds AUTO-10 (the "needs you" queue) + LIFE-6/7 (Review
  stage; responses as primary sources). A review is a **boolean question + expandable
  context**, raised by any thin-agent stage via a `reviews[]` decision channel (v1: Claims),
  written as a git-backed `reviews/` artifact. Mechanism: **per-item park** (non-terminal
  `awaiting-review` marker — only the raising item waits, the stage keeps draining) →
  **resume on verdict** (the boolean alone re-runs the item; note propagation is
  independent) → **cascade** (a re-run may raise a follow-up, bounded by a round cap). The
  answer-note is **captured as a primary source** via Ingest (LIFE-7). Surfaced as a
  **Reviews view** in the navigation shell (SPEC-0017) over a typed `listReviews`/
  `answerReview` IPC pair. Deferred: batched notifications (AUTO-15), approve-first/risk
  dispositions (AUTO-7) sharing the queue, reviews for non-Enrich flows.
- 2026-05-31 — pinned the review artifact as **`reviews/<dateShard(id)>/<id>/review.json`**
  (canonical JSON in a per-review dir), resolving the §7 layout question. JSON, not markdown
  frontmatter: a review is workflow state the app reads, not Obsidian-native knowledge —
  avoids a bespoke YAML parser (ENG simplicity). §3.2 example + raise/answer flow updated to
  match; added `raisedBy.auditRel`/`markerKey` so the answer path supersedes the park
  generically.
- 2026-05-31 — **implemented** (`app/src/kb/reviews.ts`, `reviewStore.ts`; the `reviews[]`
  decision channel + park/resume/cascade in `claims.ts`/`claimsAgent.ts`/`claimsStage.ts`;
  `answerActiveReview`/`listActiveReviews` in `main/pipeline.ts`; `kb:listReviews`/
  `kb:answerReview` IPC; the **Reviews view** `shell/views/reviewsView.ts` registered in
  the nav rail). Demonstrated end-to-end via Claims: raise → per-item park → answer
  (verdict resumes; note → primary source) → resume with the answer as context → cascade,
  bounded by a round cap. Graduated `Verify:` of REVIEW-1..14 → `test:` (36 requirement-
  traced tests; injected deciders keep CI credential-free). **Honest coverage note:** the
  graduated tests cover the domain mechanism + the view registration (REVIEW-10) + the
  store/answer logic behind the IPC (REVIEW-11); the **DOM rendering of the Reviews view and
  the Electron IPC glue are covered by e2e (CI), not unit tests** — matching the SHELL/CAPTURE
  precedent (TEST-9). REVIEW-15 (notifications) stays deferred.
- 2026-06-02 — **#110 fix: the Reviews list now stays in sync with the rail badge.** The shell
  mounts each view **once** and shows it by un-hiding (SHELL-8), so the Reviews view rendered its
  open queue a single time at first mount — while the PANEL-8 rail badge live-polls `listReviews()`
  every 5s. A review raised *after* the view first mounted (notably a **CONNECT-15 ambiguous-link
  review**, which has an **empty `subject`** and is raised by `connect`) ticked the badge to "1"
  while the frozen list still showed "Nothing needs you" — the count and the list disagreed and a
  real review couldn't be acted on. Fix: `reviewsView` now runs a **visibility-aware refresh poll**
  at the badge's cadence — it re-fetches only while shown, repaints **only when the open-review id
  set changes** (no flicker), and **never repaints while a note is being written** (focused/dirty
  textarea). The list renderer was already generic (question/detail/confirm-reject); the empty
  `subject` is now optional-chained in the `kb:listReviews` map so it can't throw and blank the
  list+badge. The Reviews view graduates from e2e-only to a **happy-dom unit test**
  (`reviewsView.test.ts`) covering link-review rendering + the badge/list reconciliation.
