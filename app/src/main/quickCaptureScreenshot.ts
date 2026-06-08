// SPEC-0038 QCAP-13 — screenshot capture for the Quick Capture sheet. Three modes map to the macOS
// `screencapture` flags (full `-x` / region `-i` / window `-w`); the PNG is written to a temp file and
// handed back as an OPAQUE handle. The bytes never pass through the renderer/DOM — on submit the main
// process reads the temp file and captures it onto the SPEC-0013 path, then deletes it.
//
// SECURITY: `consumeScreenshotHandle` reads ONLY a handle THIS module issued (tracked in `issued`), so
// a compromised/buggy renderer cannot coax the main process into reading an arbitrary path. Mirrors the
// path-containment posture at every fs-touching IPC boundary.
import { app, systemPreferences, clipboard } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ulid } from '../kb/ulid';
import type { ScreenshotMode, ScreenshotResult, ScreenshotHandle } from '../kb/types';

const execFileP = promisify(execFile);

/** Temp-PNG handles this process issued (the ONLY paths kb:quickCapture will read for a screenshot). */
const issued = new Set<string>();

const MODE_FLAG: Record<ScreenshotMode, string> = { full: '-x', region: '-i', window: '-w' };

function shotDir(): string {
  return path.join(app.getPath('temp'), 'kb-qcap-shots');
}
/** A fresh temp PNG path + a human source name, sharing one ULID. */
function newShot(prefix: string): ScreenshotHandle {
  const id = ulid();
  return { handle: path.join(shotDir(), `shot-${id}.png`), name: `${prefix}-${id}.png` };
}

/** Is `h` a handle we issued? (Exposed for the security test.) */
export function isIssuedHandle(h: string): boolean {
  return issued.has(h);
}

/**
 * Read + delete a screenshot temp PNG, but ONLY if `handle` is one we issued (else null — never read a
 * renderer-supplied arbitrary path). Single-use: the handle is de-registered + the file removed either
 * way, so a handle can't be replayed.
 */
export async function consumeScreenshotHandle(handle: string): Promise<Uint8Array | null> {
  if (!issued.has(handle)) return null;
  issued.delete(handle);
  try {
    return new Uint8Array(await fs.readFile(handle));
  } catch {
    return null;
  } finally {
    await fs.rm(handle, { force: true }).catch(() => {});
  }
}

/** Best-effort Screen-Recording TCC state (QCAP-13). Non-darwin → unsupported; anything other than a
 *  clear `granted` → denied (the sheet shows the brass steer + degrades), never a false green. */
function screenRecordingStatus(): 'granted' | 'denied' | 'unsupported' {
  if (process.platform !== 'darwin') return 'unsupported';
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/**
 * Capture a screenshot to a temp PNG handle. `denied`/`unsupported` short-circuit (no spawn). An
 * interactive region/window pick the user CANCELS leaves no file → `cancelled` (a benign no-op, not an
 * error). On success the handle is registered for a one-time `consumeScreenshotHandle` on submit.
 */
export async function captureScreenshot(mode: ScreenshotMode): Promise<ScreenshotResult> {
  const status = screenRecordingStatus();
  if (status !== 'granted') return { status, image: null };

  await fs.mkdir(shotDir(), { recursive: true });
  const shot = newShot('screenshot');
  try {
    // -x: no capture sound; the mode flag drives full/region/window. Generous timeout for an
    // interactive region/window pick; the child is killed if it truly hangs.
    await execFileP('screencapture', ['-x', MODE_FLAG[mode], shot.handle], { timeout: 120_000 });
  } catch {
    return { status: 'cancelled', image: null }; // nonzero exit (often a cancelled interactive pick)
  }
  try {
    const st = await fs.stat(shot.handle);
    if (st.size === 0) {
      await fs.rm(shot.handle, { force: true }).catch(() => {});
      return { status: 'cancelled', image: null }; // cancelled pick → empty/absent file
    }
  } catch {
    return { status: 'cancelled', image: null }; // no file produced (cancelled)
  }
  issued.add(shot.handle);
  return { status: 'granted', image: shot };
}

/**
 * QCAP-13 degrade ("paste an image"): if the clipboard holds an image, write it to a temp handle so the
 * sheet can load it the same way as a screenshot. Null when the clipboard has no image. Cross-platform.
 */
export async function clipboardImageHandle(): Promise<ScreenshotHandle | null> {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.mkdir(shotDir(), { recursive: true });
    const shot = newShot('pasted-image');
    await fs.writeFile(shot.handle, img.toPNG());
    issued.add(shot.handle);
    return shot;
  } catch {
    return null;
  }
}
