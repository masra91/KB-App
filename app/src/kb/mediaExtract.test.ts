// Media extraction policy (SPEC-0052 MEDIA) — the pure, injectable core. The live SDK vision session is
// env-gated (exercised in e2e); here we prove the guard ladder + fail-loud typed outcomes with injected
// `vision`/`session` fakes: every non-success is a distinct reason the caller surfaces, never a silent empty.
import { describe, it, expect, vi } from 'vitest';
import {
  extractMediaText,
  isExtractableMedia,
  mimeTypeForFilename,
  resolveMediaMimeType,
  type VisionLimits,
} from './mediaExtract';

const limits = (over: Partial<VisionLimits> = {}): VisionLimits => ({
  supportedMediaTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  maxImageBytes: 10_000,
  ...over,
});
const bytes = (n = 100): Uint8Array => new Uint8Array(n);

describe('media-type detection', () => {
  it('infers a mime type from the filename extension when meta carries none', () => {
    expect(mimeTypeForFilename('raw.pdf')).toBe('application/pdf');
    expect(mimeTypeForFilename('scan.PNG')).toBe('image/png');
    expect(mimeTypeForFilename('photo.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForFilename('a.tif')).toBe('image/tiff');
    expect(mimeTypeForFilename('notes.txt')).toBeUndefined(); // not media
  });
  it('resolveMediaMimeType prefers the captured mimeType, falls back to the filename', () => {
    expect(resolveMediaMimeType('application/pdf', 'x.bin')).toBe('application/pdf');
    expect(resolveMediaMimeType(undefined, 'x.png')).toBe('image/png');
    expect(resolveMediaMimeType('  ', 'x.pdf')).toBe('application/pdf'); // blank → infer
  });
  it('isExtractableMedia is true only for PDF/image kinds', () => {
    expect(isExtractableMedia('application/pdf', 'raw.pdf')).toBe(true);
    expect(isExtractableMedia(undefined, 'photo.jpg')).toBe(true);
    expect(isExtractableMedia('application/zip', 'a.zip')).toBe(false);
    expect(isExtractableMedia(undefined, 'doc.docx')).toBe(false);
  });
});

describe('extractMediaText — guard ladder + fail-loud typed outcomes', () => {
  it('SUCCESS: transcribes via the injected vision session → trimmed text', async () => {
    const session = vi.fn(async (input: { mimeType: string; dataBase64: string; filename: string }) => {
      expect(input.mimeType).toBe('application/pdf');
      expect(input.dataBase64.length).toBeGreaterThan(0); // base64 of the bytes
      return { text: '  Hello from the PDF.\n' };
    });
    const res = await extractMediaText(bytes(), 'application/pdf', 'raw.pdf', { vision: async () => limits(), session });
    expect(res).toEqual({ ok: true, text: 'Hello from the PDF.' });
    expect(session).toHaveBeenCalledOnce();
  });

  it('NO-VISION-MODEL: a null vision probe → needs-setup, NO session call (MEDIA-7 fail-loud)', async () => {
    const session = vi.fn();
    const res = await extractMediaText(bytes(), 'application/pdf', 'raw.pdf', { vision: async () => null, session });
    expect(res).toMatchObject({ ok: false, reason: 'no-vision-model' });
    expect(session).not.toHaveBeenCalled();
  });

  it('NO-VISION-MODEL: a throwing vision probe is also needs-setup (never silent)', async () => {
    const res = await extractMediaText(bytes(), 'application/pdf', 'raw.pdf', {
      vision: async () => { throw new Error('probe down'); },
      session: vi.fn(),
    });
    expect(res).toMatchObject({ ok: false, reason: 'no-vision-model' });
    if ('error' in res) expect(res.error).toContain('probe down');
  });

  it('UNSUPPORTED-TYPE: the model can\'t read this mime → typed reason, no session call', async () => {
    const session = vi.fn();
    const res = await extractMediaText(bytes(), 'image/heic', 'photo.heic', {
      vision: async () => limits({ supportedMediaTypes: ['application/pdf'] }),
      session,
    });
    expect(res).toMatchObject({ ok: false, reason: 'unsupported-type' });
    expect(session).not.toHaveBeenCalled();
  });

  it('TOO-LARGE: bytes over the model limit → set-aside reason, never a silent truncation (MEDIA-6)', async () => {
    const session = vi.fn();
    const res = await extractMediaText(bytes(20_000), 'image/png', 'big.png', {
      vision: async () => limits({ maxImageBytes: 10_000 }),
      session,
    });
    expect(res).toMatchObject({ ok: false, reason: 'too-large' });
    if ('error' in res) expect(res.error).toMatch(/20000.*10000/);
    expect(session).not.toHaveBeenCalled();
  });

  it('EXTRACT-FAILED: a session error → set aside + surfaced cause, no throw (MEDIA-5)', async () => {
    const res = await extractMediaText(bytes(), 'application/pdf', 'raw.pdf', {
      vision: async () => limits(),
      session: async () => { throw new Error('model exploded'); },
    });
    expect(res).toMatchObject({ ok: false, reason: 'extract-failed' });
    if ('error' in res) expect(res.error).toContain('model exploded');
  });

  it('an empty transcription is a valid (honest) success — the caller keeps the embed', async () => {
    const res = await extractMediaText(bytes(), 'image/png', 'blank.png', {
      vision: async () => limits(),
      session: async () => ({ text: '   ' }),
    });
    expect(res).toEqual({ ok: true, text: '' });
  });

  it('empty supportedMediaTypes (model declares none) does NOT block — only an explicit miss does', async () => {
    const res = await extractMediaText(bytes(), 'image/png', 'x.png', {
      vision: async () => limits({ supportedMediaTypes: [] }),
      session: async () => ({ text: 'ok' }),
    });
    expect(res).toEqual({ ok: true, text: 'ok' });
  });
});
