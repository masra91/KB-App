---
spec: SPEC-0052
key: MEDIA
title: Binary / Media Intake (PDF + image OCR via the Copilot SDK multimodal path)
type: feature
status: draft
owners: [KB-Lead, Principal]
related: [SPEC-0008, SPEC-0013, SPEC-0007, SPEC-0040, SPEC-0010]
created: 2026-06-27
stage: Ingest
supersedes: null
---

# Binary / Media Intake — make dropped PDFs and images actually enter the KB

> **Today a dropped PDF does nothing.** It is stored as binary `raw.pdf`, the source body
> becomes an opaque Obsidian embed `![[raw.pdf]]`, and `textContent` is `null` at
> `orchestrator.ts:92` — so its content never reaches any agent and nothing is decomposed.
> Images pasted/dropped have the same dead end. This spec gives binary media a **text body**
> so the existing pipeline (decompose → claims → connect → …) can treat it like any source.

## 1. The mechanism — extract at archive time, through Copilot

The provider is the **GitHub Copilot SDK** (per [SPEC-0010]; no direct Anthropic API). The SDK
**does** support multimodal input — verified in `@github/copilot-sdk@1.0.0-beta.7` and GitHub's
docs:
- `MessageOptions.attachments` accepts `{ type: "blob", data: <base64>, mimeType }` (also `file`).
- `ModelCapabilities.supports.vision: boolean` + `limits.vision { supported_media_types[],
  max_prompt_images, max_prompt_image_size }`; `supportedNativeDocumentMimeTypes` for native PDF.

So the extraction step passes the binary as a **blob attachment to a vision-capable model** and
asks it to transcribe/describe → that text becomes the source body. The original binary is
preserved (kept as `raw.<ext>` + the `![[raw.<ext>]]` embed) so the human view and replay are
intact.

## 2. Insertion point — the convergence guarantee ("understand anything, any path")
A new extraction step at the archive boundary (`orchestrator.ts:92`, where `textContent` is
computed for `meta.kind !== 'text'`). Extracted text is woven into the source body via
`sourceDoc.bodyFor` (today returns only the embed for non-text). Lives behind a small
`mediaExtract.ts` module so the policy is testable and the orchestrator stays thin.

**Why this is universal (Principal's framing — "if something gets ingested by ANY means, can we
understand it"):** every ingestion path — in-app drag/paste (SPEC-0040), Quick Capture (SPEC-0038),
**Watched folders (SPEC-0037)**, Proactive Intake (SPEC-0041) — lands in `inbox/` and drains through
this **same** archive boundary. Putting extraction here means *no ingestion path is a dead end*: a
PDF or image arriving by any route gets a comprehensible body and flows the pipeline. Capture specs
stay capture-only (RICHIN-5 correctly defers extraction to Enrich); comprehension is owned **here**,
at the one point they all converge.

## 3. Tiering (cost) — optional local fast-path
For PDFs **with a digital text layer**, a local `pdfjs-dist` extraction can run first and skip the
model call entirely; the multimodal path is the fallback for scanned/image-only PDFs and for
images. This is an optimization, not required for v1 — v1 may go multimodal-only. **No Tesseract /
Tika** (the JVM/native footprint violates the E1 fewer-deps rule); any new dep (`pdfjs-dist`) is
pinned and ≥7-day per E1.

## 4. Failure & guards
- Extraction is **per-item isolated** (ENG-16): a failed extraction sets the source aside with a
  surfaced error, never crashes the drain.
- Size/page guards: respect `limits.vision` (image count/size) and a page cap for PDFs; oversize
  inputs set aside with a clear "too large" reason rather than a silent truncation.
- If no vision-capable model is configured/available, emit a loud `needs-setup` audit event (not a
  silent empty body) — mirrors the WORKIQ fail-loud posture.

## 5. Requirements (must unless noted) — `Verify: none-yet → test:`
- **MEDIA-1** A dropped/captured PDF produces a source whose **body contains extracted text**, not
  just the `![[raw.pdf]]` embed; the source then flows through decompose/claims like any text source.
  `Verify: none-yet → test:`
- **MEDIA-2** A dropped/pasted **image** (png/jpg/…) likewise produces a text body (description /
  transcription). `Verify: none-yet → test:`
- **MEDIA-3** Extraction goes through the **Copilot SDK** `attachments` blob path to a
  **vision-capable** model (checked via `ModelCapabilities.supports.vision`); **no direct
  Anthropic/Claude API**. `Verify: none-yet → test:`
- **MEDIA-4** The **original binary is preserved** (raw file + Obsidian embed) alongside the
  extracted text — extraction is additive, replay-safe. `Verify: none-yet → test:`
- **MEDIA-5** Extraction failure is **per-item set-aside with a surfaced error**; the drain
  continues (ENG-15/16). `Verify: none-yet → test:`
- **MEDIA-6** Oversize input (exceeds `limits.vision` or the PDF page cap) is set aside with an
  explicit reason, never silently truncated. `Verify: none-yet → test:`
- **MEDIA-7** When no vision model is available, a configured media source emits a loud
  `needs-setup`/`research-failed`-style audit event surfaced in Activity, not a silent empty body.
  `Verify: none-yet → test:`
- **MEDIA-8** (should) For PDFs with a digital text layer, a local fast-path may extract without a
  model call; behavior (resulting body) is equivalent to the multimodal path. `Verify: none-yet → test:`
- **MEDIA-9** Any new dependency is reputable, pinned, and ≥7 days old (E1); no JVM/native OCR
  engine (Tika/Tesseract) is added. `Verify: none-yet → test:` (dep-audit / lockfile check)
- **MEDIA-10** **Universal guarantee:** extraction applies to non-text sources from **every**
  ingestion path (in-app drag/paste, Quick Capture, Watched folders, Proactive Intake), because all
  converge on the archive boundary — no path leaves a binary source with an empty/opaque body.
  `Verify: none-yet → test:` (a PDF arriving via watched-folder and via drag both get a text body)

## 6. Out of scope (v1)
- Layout-faithful reconstruction (tables/columns) beyond what the model returns.
- Audio/video transcription.
- Per-page entity provenance (page-level citations) — defer; v1 attributes to the source.
