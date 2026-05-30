# Living Specs

This folder is the **source of intent** for KB-App. The code, tests, and UI are
downstream of what's written here. If a spec and the code disagree, that is a bug
in one of them — and the spec is where we decide which.

These are **living** documents: they evolve with the product, carry status, and
are meant to be re-read continuously. They are not a one-time design dump.

## Why this exists — the "semantic test surface"

We want to be able to ask, at any point in the build, three questions and get a
real answer rather than a vibe:

1. **Do the features still meet their requirements?** (product ↔ behavior)
2. **Do the tests cover the requirements?** (requirements ↔ tests)
3. **Is anything in the code that no requirement asked for?** (behavior ↔ intent)

That is only possible if every requirement is **individually addressable** and
**declares how it is verified**. So the whole system is built around two rules:

- Every requirement has a **stable ID** (e.g. `SPECSYS-3`).
- Every requirement declares a **verification method** (test / manual / AI-eval / none-yet).

Tests, PRs, and future tooling reference those IDs. That turns this folder into a
surface we can mechanically — and semantically — check coverage against.

## What a spec is (and isn't)

A spec captures, in this order of importance:

- **Intent** — the job-to-be-done and *why* this exists. The most durable part.
- **User flows / feature surface** — what the user experiences and does.
- **Requirements** — normative, testable statements with stable IDs.
- **Open questions** — what we haven't decided yet (first-class, not hidden).

A spec is **not** a tech design doc by default. Right now we are deliberately
sketching the **product surface** — features, flows, intent — and leaving tech
choices out. Architecture specs come later and must trace back to product specs.

## Spec types

Set in each spec's `type:` frontmatter and reflected by which folder it lives in:

| type           | folder           | captures                                              |
| -------------- | ---------------- | ----------------------------------------------------- |
| `product`      | `product/`       | JTBD, principles, vision, the product surface         |
| `feature`      | `features/`      | a single feature: its flow, surface, requirements     |
| `architecture` | `architecture/`  | system design & tech decisions (later; traces to above) |
| `meta`         | `./` (root)      | the spec system itself                                |

## Requirement IDs & traceability

Each spec declares a short uppercase **`key`** in frontmatter (e.g. `SPECSYS`,
`VAULT`, `CAPTURE`). Requirements inside it are numbered against that key:

```
SPECSYS-1, SPECSYS-2, ...
```

IDs are **stable and never reused**. If a requirement is removed, its ID is
retired (marked `withdrawn`) — we never recycle a number, because tests and
history point at it.

A requirement is written as a normative statement using RFC-2119 keywords
(**MUST**, **SHOULD**, **MAY**) so its truth value is checkable.

## Status lifecycle

Specs and individual requirements carry status:

- `draft` — being shaped; not yet binding.
- `active` — binding; code/tests are expected to satisfy it.
- `deprecated` — still true for now, but on the way out.
- `superseded` — replaced; points to what replaced it.
- `withdrawn` — (requirements only) intentionally removed; ID retired.

## Verification methods

Every requirement names how we know it holds (`Verify:` line):

- `test:<id-or-path>` — an automated test asserts it.
- `manual:<note>` — checked by hand / demo script.
- `ai-eval` — judged by a semantic eval against the spec text.
- `none-yet` — acknowledged gap. Honest > silent.

`none-yet` is allowed and expected during product sketching — it just shows up as
an uncovered requirement, which is exactly the signal we want.

## Workflow

1. Copy `TEMPLATE.md` into the right folder, named `SPEC-NNNN-slug.md`.
2. Reserve the next `SPEC-NNNN` number and a `key`; add a row to `INDEX.md`.
3. Lead with **intent** and **flows**. Write requirements last — they fall out of
   the flow, they don't precede it.
4. Keep **Open Questions** honest. Unknowns are content, not failure.
5. When behavior changes, update the spec in the *same* change. The spec is part
   of "done."

## Layout

```
specs/
  README.md            ← you are here
  INDEX.md             ← registry of every spec + status
  TEMPLATE.md          ← copy this to start a new spec
  SPEC-0000-living-spec-system.md   ← the system, defined in its own format
  product/             ← product surface, JTBD, principles
  features/            ← per-feature specs
  architecture/        ← tech & system design (added later)
  tools/               ← tooling that reads these specs (added later)
```

> The `tools/` folder is where the "and code" part lives eventually: a small
> checker that extracts requirement IDs + verification methods and reports
> coverage / orphans / drift. We are not building it yet — but every convention
> above exists so that it can be trivial when we do.
