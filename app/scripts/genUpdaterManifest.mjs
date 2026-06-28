// Generate the electron-updater macOS feed manifest (`latest-mac.yml`) from the packaged .zip
// (SPEC-0055 RELEASE-5; consumed by SPEC-0056 auto-update). electron-updater's mac channel reads a
// `latest-mac.yml` describing the latest build + the .zip it download-applies; the human-facing .dmg is
// a separate download. We're on electron-FORGE (which doesn't emit this builder-format manifest), so we
// generate it deterministically from the artifact MakerZIP produced.
//
//   Usage:  node scripts/genUpdaterManifest.mjs <version>     # version without the leading 'v'
//
// Writes `out/latest-mac.yml` next to the artifacts for the release workflow to upload.
//
// NOTE(SPEC-0056 coordination): this is the standard electron-updater shape (version · files[url,sha512,
// size] · path · sha512 · releaseDate). If 0056 pins a different updater/feed, adjust here — the rest of
// the release pipeline is agnostic to the manifest body.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const version = (process.argv[2] ?? '').trim().replace(/^v/, '');
if (!version) {
  console.error('genUpdaterManifest: missing <version> arg (e.g. 1.2.3)');
  process.exit(2);
}

/** Recursively find the first darwin .zip MakerZIP produced under out/make/zip/darwin. */
async function findMacZip(root) {
  const base = path.join(root, 'out', 'make', 'zip', 'darwin');
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = await walk(p);
        if (hit) return hit;
      } else if (e.name.endsWith('.zip')) {
        return p;
      }
    }
    return null;
  }
  return walk(base);
}

const cwd = process.cwd();
const zip = await findMacZip(cwd);
if (!zip) {
  console.error('genUpdaterManifest: no darwin .zip under out/make/zip/darwin — did `electron-forge make` run?');
  process.exit(1);
}

const bytes = await fs.readFile(zip);
const sha512 = createHash('sha512').update(bytes).digest('base64'); // electron-updater uses base64 sha512
const size = bytes.length;
const file = path.basename(zip);
const releaseDate = new Date().toISOString();

// electron-updater latest-mac.yml (minimal valid shape). YAML hand-emitted to avoid a yaml dep.
const yml = [
  `version: ${version}`,
  `files:`,
  `  - url: ${file}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${file}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');

const outPath = path.join(cwd, 'out', 'latest-mac.yml');
await fs.writeFile(outPath, yml, 'utf8');
console.log(`Wrote ${outPath}\n${yml}`);
