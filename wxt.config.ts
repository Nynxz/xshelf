import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";

export default defineConfig({
  srcDir: "src",
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: "X Bookmark Downloader",
    description:
      "Backs up your X/Twitter bookmarks (text, full-res images, videos, metadata). Read-only — never modifies your bookmarks.",
    version: "0.2.0",
    permissions: ["downloads", "storage", "unlimitedStorage", "webRequest"],
    host_permissions: [
      "https://x.com/*",
      "https://twitter.com/*",
      "https://api.x.com/*",
      "https://api.twitter.com/*",
      "https://pbs.twimg.com/*",
      "https://video.twimg.com/*",
    ],
    web_accessible_resources: [
      {
        resources: ["explorer.html"],
        matches: ["<all_urls>"],
      },
    ],
  },
});
