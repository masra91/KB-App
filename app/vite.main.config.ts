import { defineConfig } from 'vite';

// https://vitejs.dev/config
// Bundle node-side deps (e.g. simple-git) into the main bundle so they're present in
// the packaged app.asar. simple-git is pure JS (shells out to the `git` binary), so
// bundling is safe — externalizing it instead breaks the packaged build (deps aren't
// copied into app.asar by the Vite plugin). Native modules would go through
// @electron-forge/plugin-auto-unpack-natives instead.
export default defineConfig({});
