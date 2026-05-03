import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Standalone build for the master xshelf/index.html — the cross-source
 * explorer with a sidebar. Built with vite-plugin-singlefile so the
 * Preact bundle + CSS are inlined; the SW imports the result as a
 * `?raw` string at extension build time, splices in <script src> tags
 * for each known source's data.js, and writes to disk.
 *
 * Mirrors vite.snapshot.config.ts but for a different entry.
 */
export default defineConfig({
  root: resolve(__dirname, "src/master"),
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "src/master/dist"),
    emptyOutDir: true,
  },
});
