---
spec: SPEC-0006
key: AUTO
title: Agent Autonomy & Approval
type: product
status: draft
owners: [KB-Architect, Principal]
created: 2026-05-30
updated: 2026-05-30
related: [SPEC-0002, SPEC-0003, SPEC-0004, SPEC-0005]
supersedes: null
---

# Agent Autonomy & Approval

> What agents may do unattended, what they must raise first, and why high autonomy is
> *safe* here. Resolves cross-cutting **Fork 2**.

## 1. Intent (the why / JTBD)

The product's magic *requires* high autonomy — the day-in-the-life story is "a
fire-and-forget note spawned a whole workstream **without me having to take action**."
Gate too much and the second brain degrades into a to-do list. So the goal is not to
limit autonomy but to find the **right axis to gate on**, keeping autonomy high where
it's safe and gated only where it genuinely must be.

## 2. Governing principle

> **Gate on irreversibility, cost, and egress — *not* on KB mutation.**

The KB is versioned, auditable, and replayable (PRIN-7; LIFE-9/10), so **almost
everything an agent does *inside* the KB is reversible** — a bad merge, wrong link, or
sloppy entity can be rolled back or replayed away. Gating reversible in-KB work buys no
safety and kills the magic.

What is *not* reversible — and therefore deserves a gate — is a short list:
- **Egress** — sending KB content *out* (web search, external API). Can't un-send.
- **Cost** — spending money/compute. Can't un-spend. *(Delegated — see §5.)*
- **External side-effects** — acting in the world (send email, modify systems). Can't un-happen.

## 3. Action-class posture

| Action class | Reversible? | Posture | Notes |
| ------------ | ----------- | ------- | ----- |
| Decompose / summarize / link **within KB** | ✅ | **Auto (silent)** | reversible, audited, replayable |
| Create / merge / retire entities, edit metadata | ✅ | **Auto**, but **raise low-confidence / high-risk** | uncertainty → Review (Fork 1) |
| Read **connected internal sources** (calendar, email, internal DB) | ✅ | **Auto** | scoped per connector defaults (SCOPE-14) |
| **External read** (web search, fetch URL) | ⚠️ egress | **Auto, egress-filtered** | no content above a sensitivity ceiling leaves |
| **Spend** (tokens/$/API) | ❌ | **Delegated to agent provider** (BYOA) | app does not own/gate cost; §5 |
| Produce **audience-facing outputs** (reports, answers) | n/a | **Principal-initiated only** (pull, not push) | + governed by surfacing policy (SCOPE-11) |
| Produce **internal knowledge** (entities/links/summaries) | ✅ | **Auto** (this *is* Enrich) | feeds the KB, not an audience |
| **External side-effects** (send mail, post, write external systems) | ❌ | **Not supported** | the KB is **not an actor**; read-only world |

## 4. Disposition & observability

Every agent action has one of three **dispositions**, chosen by risk + confidence +
reversibility:

| Disposition | When | Surfaces in |
| ----------- | ---- | ----------- |
| **Silent** | most actions: reversible, confident, low-risk | audit log only |
| **Notify (FYI)** | did it, but worth knowing | **activity feed / digest** |
| **Raise (approve-first)** | low-confidence, high-risk, irreversible | **"needs you" queue** (shared with Review) |

**Nothing is truly invisible.** The **audit log is the raw, complete substrate** —
every action, including silent ones (LIFE-9). Two human-friendly **derived views** sit
on top:
- **Activity feed / digest** — curated, batched "what your librarians did" stream
  (FYIs + summaries); itself a derived artifact, optionally produced by a Reflect agent.
- **"Needs you" queue** — approve-first items alongside Review escalations (Fork 1),
  with batched notifications (dock badge / tray).

We don't build new notification machinery: **audit = source of truth; feed and queue =
derived views over it** (PRIN-5 simplicity).

## 5. Cost model — Bring Your Own Agent (BYOA)

- The app **does not own or gate model cost**. The Principal **brings their own agent /
  subscription**; the app **piggybacks the provider's cost-control features**.
- The app exposes **light configuration** — e.g. effort level / model choice — within
  what the chosen harness supports.
- The audit log **surfaces available usage telemetry** (turns, and tokens/cost if the
  provider exposes them) for **observability**, not enforcement.
- The **specific provider/harness is a deferred architecture decision** (GitHub Copilot
  SDK is the anchoring candidate, per the project's origin). BYOA is the product stance.

## 6. Configurability

Autonomy posture, egress ceilings, and disposition thresholds are **configurable per
Instance/Scope** (Fork 1). The **Work** instance can be stricter (more raise-first,
lower egress ceiling) than **Personal**.

## 7. Requirements

| ID       | Priority | Statement (short)                                                  | Verify   | Traces |
| -------- | -------- | ------------------------------------------------------------------ | -------- | ------ |
| AUTO-1   | must     | Autonomy gates on irreversibility, cost, and egress — not on reversible KB mutation | none-yet | PRIN-3,7 |
| AUTO-2   | must     | In-KB derivation/linking/summarization (Enrich) runs automatically and audited | none-yet | PRIN-3; LIFE-3 |
| AUTO-3   | must     | Entity create/merge/retire runs automatically but raises low-confidence/high-risk to Review/approval | none-yet | PRIN-4; LIFE-6 |
| AUTO-4   | must     | Reads of connected sources and external reads run automatically; external reads are egress-filtered above a sensitivity ceiling | none-yet | PRIN-19; SCOPE-11 |
| AUTO-5   | must     | Audience-facing outputs are Principal-initiated (pull), not autonomously pushed | none-yet | VISION-9 |
| AUTO-6   | must     | Agents take NO external side-effecting actions; the KB is read-only w.r.t. the world | none-yet | PRIN-3 |
| AUTO-7   | must     | Every action has a disposition: silent / notify / approve-first, by risk+confidence+reversibility | none-yet | PRIN-3 |
| AUTO-8   | must     | Every action (incl. silent) is recorded in the audit log — with the agent's decision/intent (the *why*), not just the *what*; nothing is invisible | none-yet | PRIN-5,6,22; LIFE-9 |
| AUTO-9   | should   | A curated activity feed/digest provides a human-friendly view over the raw audit log | none-yet | PRIN-22; LIFE-9 |
| AUTO-10  | must     | Approve-first items & Review escalations surface in a shared "needs you" queue with batched notifications | none-yet | LIFE-6 |
| AUTO-11  | must     | The app does not own/gate model cost; cost is delegated to the provider (BYOA); usage telemetry is observed, not enforced | none-yet | PRIN-16 |
| AUTO-12  | should   | Autonomy posture, egress ceilings, and thresholds are configurable per Instance/Scope | none-yet | PRIN-20; SCOPE-1 |

### AUTO-1 — Gate on irreversibility, cost, egress
- **Status:** draft · **Priority:** must
- **Statement:** Agent autonomy **MUST** be bounded by irreversibility, cost, and
  egress — **not** by whether an action mutates the KB. Reversible in-KB work
  **SHOULD** run without approval (audited).
- **Rationale:** KB mutations are versioned/replayable, so they're recoverable;
  gating them sacrifices the core magic for no safety gain. The genuine risks are
  un-sendable egress, un-spendable cost, and un-happenable world actions.
- **Traces:** PRIN-3, PRIN-7, PRIN-16
- **Verify:** none-yet

### AUTO-6 — Not an actor
- **Status:** draft · **Priority:** must
- **Statement:** Agents **MUST NOT** take side-effecting actions in external systems
  (sending email, posting, writing to external services). The KB ingests and derives;
  it does not act in the world.
- **Rationale:** Acting in the world is a separate, larger risk surface and is not
  needed for the core loop. Explicitly out of scope for now.
- **Traces:** PRIN-3, PRIN-6
- **Verify:** none-yet

## 8. Open questions

- [ ] **Risk/confidence thresholds** — what concretely makes an action "high-risk" or
      "low-confidence" enough to flip silent → notify → raise? (A scoring rubric per
      action type; refine as agents land.)
- [ ] **Activity feed shape** — is the digest time-based (daily), volume-based (every N
      actions), or event-based (per workstream completion)? Lives in the Audit feature.
- [ ] **Provider telemetry availability** — which harness actually exposes per-turn
      token/cost so the audit log can report effort? (Architecture; informs provider choice.)
- [ ] **Light expansion bounds later** — Principal deferred cost gating to the provider;
      revisit if a depth/breadth bound on workstreams is still wanted independent of cost.
- [ ] **Connector "internal" relativity** — what one connector treats as `internal`,
      another may not (SCOPE-14). How are connector sensitivity defaults set/edited?

## 9. Changelog

- 2026-05-30 — created (draft). Resolved Fork 2. Governing principle (gate on
  irreversibility/cost/egress); action-class posture; three-tier disposition with
  audit-as-substrate; BYOA cost model; per-Instance/Scope configurability;
  read-only-world (AUTO-6); output is pull not push (AUTO-5).
