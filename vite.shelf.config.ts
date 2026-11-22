import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The new shelf explorer, written to xshelf/index.html (the classic master
 * explorer moves to xshelf/classic.html). Same singlefile + `?raw` +
 * script-sentinel mechanism as vite.master.config.ts.
 */
export default defineConfig({
  root: resolve(__dirname, "src/shelf"),
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "src/shelf/dist"),
    emptyOutDir: true,
  },
});
