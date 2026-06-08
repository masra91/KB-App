import { defineConfig } from 'vite';

// https://vitejs.dev/config
// Bundle node-side deps (e.g. simple-git) into the main bundle so they're present in
// the packaged app.asar. simple-git is pure JS (shells out to the `git` binary), so
// bundling is safe — externalizing it instead breaks the packaged build (deps aren't
// copied into app.asar by the Vite plugin). Native modules go through
// @electron-forge/plugin-auto-unpack-natives instead (see forge.config.ts).
export default defineConfig({
  build: {
    rollupOptions: {
      // `fsevents` is a macOS-only NATIVE optionalDependency that chokidar (the WATCH watcher,
      // SPEC-0037) lazy-requires at runtime. Rollup cannot bundle a `.node` binary — on macOS the
      // package build died with `fsevents/fsevents.node: Unexpected character` (via chokidar/index.js).
      // (Linux/CI never hit it: fsevents has `os: ["darwin"]`, so it isn't installed off macOS and the
      // lazy require degrades — which is why the ubuntu-only build-check stayed green.)
      // Externalize it so the lazy require resolves at runtime from node_modules; the native is then
      // loaded from outside the asar by plugin-auto-unpack-natives (app.asar.unpacked). Externalizing
      // ONLY this native (not the pure-JS deps above) keeps the rest bundled into app.asar as before.
      external: ['fsevents'],
    },
  },
});
