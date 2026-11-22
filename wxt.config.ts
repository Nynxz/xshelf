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
      "Back up your X/Twitter bookmarks and profile media to a local archive with an offline explorer.",
    permissions: [
      "downloads",
      "downloads.open",
      "storage",
      "unlimitedStorage",
      "webRequest",
    ],
    host_permissions: [
      "https://x.com/*",
      "https://twitter.com/*",
      "https://api.x.com/*",
      "https://api.twitter.com/*",
      "https://pbs.twimg.com/*",
      "https://video.twimg.com/*",
    ],
  },
});
