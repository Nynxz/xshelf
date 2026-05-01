import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Standalone Vite build for the on-disk explorer snapshot.
 *
 * The output is a single self-contained `public/snapshot.html` that WXT then
 * copies into the extension package. The service worker reads it at runtime,
 * injects the manifest as inline JSON, and writes the result to
 * `~/Downloads/<folder>/explorer.html` so the user can open it from their
 * file manager and browse media via relative paths (file://).
 *
 * Has to be a separate build from WXT's main build because vite-plugin-singlefile
 * sets `output.inlineDynamicImports: true`, which Rollup forbids when there are
 * multiple inputs (popup + background + explorer).
 */
export default defineConfig({
  root: resolve(__dirname, "src/snapshot"),
  plugins: [preact(), viteSingleFile()],
  build: {
    // Output to src/snapshot/dist/ rather than public/. WXT was re-processing
    // public/index.html as one of its own HTML entries, which undid the
    // singlefile inlining (re-chunked into hashed JS files that don't resolve
    // from file://). Putting it under src/ lets background.ts import the
    // built HTML as a raw string via Vite's `?raw` suffix, baking it into
    // the SW bundle at build time.
    outDir: resolve(__dirname, "src/snapshot/dist"),
    emptyOutDir: true,
  },
});
