# Egress cassettes (SPEC-0042 EVAL-6)

Recorded request→response fixtures that let RESEARCH/external scenarios replay **deterministically** and
**without hitting the live web**. A scenario references its cassette via `meta.cassette` (default
`<scenario-id>.json`). The runner serves fetches from the cassette in REPLAY mode (the default) and
**errors on a cache miss** — a replay can never silently fall through to the network.

These are committed reproducibility **inputs** (unlike the gitignored Slice-2 baselines, which are run
outputs). Review a cassette like code.

## ⚠️ HARD GUARDRAIL — PUBLIC-WEB egress ONLY (KB-Lead-ratified S3-B; EVAL-6)

A committed cassette may contain **PUBLIC-WEB egress only**: request-only URLs (D6a) + public response
content. **NEVER** record or commit internal-tenant / M365 / any private-data egress into a cassette —
that would commit tenant PII/secrets into the repo (an EVAL-6 violation). Those tiers stay **live-env-gated**
or use **hand-authored SYNTHETIC fixtures**, never recorded real private data.

This is enforced in code, not just by convention (`eval/runner/cassette.ts`):

- **`tier` must be `"public-web"`** — `assertCassetteClean` refuses any other tier on load/save.
- **Secret scrub on record + fail-loud** — `makeRecordingFetch` scrubs auth/token material from every
  response; `assertCassetteClean` then re-scans and **throws** if any secret pattern (GitHub/OpenAI/AWS
  keys, JWTs, bearer tokens, basic-auth URLs, `token=`/`secret=` query params, …) survives. An unscrubbed
  cassette can neither be written nor replayed.
- **The gate runs on record** — recording WRAPS the real `makeGatedFetch`, so the SSRF/allowlist gate
  (`isAllowedUrl` + the SSRF-safe DNS lookup) governs every captured request; only pre-gated responses land.

## Refreshing a cassette (`--live`)

Re-record with a live BYOA copilot + network:

```bash
cd app && KB_EVAL=1 KB_EVAL_RECORD=1 npm run eval
```

The record run wraps `makeGatedFetch` (gate enforced), scrubs + collects responses, and overwrites the
cassette only after the fail-loud clean check passes.

## Replay fidelity

Replay matches by **exact request URL**. The research scenarios PIN the researcher's prompt to one
allowlisted URL (no free web-search) so the agent fetches exactly the recorded request and replay is
deterministic. If a future prompt/model change makes the agent fetch a different URL, replay will **error
loudly** on the miss (by design) — re-record with `--live` to refresh.

## Files

- `research-web.json` — public-web fetch of `https://en.wikipedia.org/wiki/COBOL` for the `research-web`
  scenario. Public factual content (no secrets/PII); refresh via `--live`.
