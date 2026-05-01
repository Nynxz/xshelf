# xshelf

A browser extension that **backs up your X / Twitter bookmarks** — text, full-resolution images, videos, author info, post URLs, engagement counts — to your local disk. Then renders a fully-offline HTML viewer alongside the media so you can browse everything later without the network.

**Read-only.** The extension never modifies the bookmarks on your account. It uses your existing logged-in session to read X's bookmarks API, just like the browser does when you visit your bookmarks page. Ideal for keeping a personal archive, recovering from an accidental wipe, or migrating bookmarks between accounts (you have a list of every URL).

> Status: works for me on Chromium-based browsers (Chrome, Brave, Edge). Firefox build target exists via WXT but is untested. Not yet on the Chrome Web Store — install from source.

---

## What you get

After running a sync + download, your `~/Downloads/xshelf/` (default folder name; configurable) looks like:

```
xshelf/
  explorer.html         # offline viewer — open this in your browser
  media/
    elonmusk/
      1234567890_0.jpg
      1234567890_1.jpg
      9876543210_0.mp4
    naval/
      ...
```

Open `explorer.html` and you get:

- **List view** — Twitter-style cards: display name, @handle, date, full text with auto-linked URLs/hashtags/mentions, inline media (photos and videos at full resolution), and reply / retweet / like / quote counts.
- **Grid view** — packed thumbnail grid for visual browsing of all your saved media.
- **Lightbox** — click any image to view full-size with keyboard nav (`←`/`→`/`Esc`/`i`). The tweet text panel can be toggled with the `i` key.
- **Search** across text, @username, and display name.
- **Filters** — by user, by media type (photos / videos / text-only).
- **Sort** by newest bookmarked, oldest bookmarked, newest tweet, oldest tweet, by user, or by like count.
- **Display options** (gear icon) — image size (small/medium/large) and image fit (Contain to see whole image, Cover to crop).
- All client-side, all from a single file. **No network calls** — the viewer never reaches out to X / Twitter for anything.

---

## Privacy

The exported `explorer.html` is **strictly offline**. There are no remote-URL fallbacks for missing media, no analytics, no tracking pixels, no fonts loaded from CDNs, no anything. Every asset is either inlined in the HTML (the Preact runtime + CSS, baked in via `vite-plugin-singlefile`) or loaded from a relative path that resolves on your local filesystem. If you delete a media file from your Downloads folder, the viewer shows a "not available offline" placeholder for that one item — it does not silently fall back to fetching the original.

The extension itself only talks to:
- `x.com` / `twitter.com` / `api.x.com` / `api.twitter.com` — to read your bookmarks (via your own session cookies).
- `pbs.twimg.com` / `video.twimg.com` — to download the media files to your disk.

Host permissions are scoped to exactly those domains. No content scripts.

---

## Install (from source)

```bash
git clone https://github.com/<you>/xshelf.git
cd xshelf
npm install
npm run build       # → .output/chrome-mv3/
```

Then in your browser:

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**, select the `.output/chrome-mv3/` directory.

When prompted, accept the `downloads.open` permission — that's what lets the popup's "Open explorer" button open the offline HTML in a new tab.

For Firefox: `npm run build:firefox`, then load `.output/firefox-mv2/` via `about:debugging` → This Firefox → Load Temporary Add-on.

---

## Usage

1. Open `https://x.com/i/bookmarks` and scroll once so the extension can capture your session headers (Authorization + CSRF token).
2. Click the extension icon → **Start sync**.
3. Wait for sync to finish. The popup shows a per-user breakdown of pending media — review and click **Download all**, or **Discard pending** to skip.
4. After the run, click **Open explorer** to view the offline HTML.

The whole pipeline lives in the background service worker, so closing and reopening the popup never loses progress. Cancel works at any time. If your browser is restarted mid-run, the extension marks the run as "interrupted" and resumes from where it left off — no re-fetching of completed pages or re-downloading of completed media.

---

## How it works (architecture)

1. **Capture** — `chrome.webRequest.onSendHeaders` watches your existing X requests for the live `Authorization` and `x-csrf-token` headers, plus the rotating `Bookmarks` GraphQL operation name + query-id. The extension never makes its first API call until the user clicks Start.
2. **Sync** — paginates X's `Bookmarks` GraphQL endpoint via `fetch` + captured headers + your existing session cookies (`credentials: "include"`). Parses each tweet, merges into a manifest in `chrome.storage.local`. Audits the manifest against `chrome.downloads.search` history (concurrency-capped at 4 so it doesn't freeze the browser) so files already on disk aren't re-fetched.
3. **Review** — popup surfaces a pending list with per-user breakdown. The user picks **Download all** or **Discard**.
4. **Download** — `chrome.downloads.download` with `conflictAction: "overwrite"` for each pending item; progress and cancel both work regardless of whether the popup is open.
5. **Snapshot** — at the end of every sync (and every download), the SW takes the pre-built singlefile `index.html` (Preact + CSS bundled inline at build time via Vite + `vite-plugin-singlefile`, imported into the SW as a `?raw` string), injects the user's manifest as inline JSON, and writes the result to `~/Downloads/<folder>/explorer.html`.
6. **Browse** — the snapshot file is a self-contained Preact app. It reads bookmarks from its inline JSON, references local media via relative paths (`media/<user>/<id>.jpg`), and works entirely offline.

### Sort key for "newest bookmarked"

X doesn't expose a "bookmarked at" timestamp. Workaround: every visited bookmark gets re-stamped on every sync with:
- `lastSeenAt` — a single timestamp captured at sync start (identical for every bookmark visited in that sync).
- `lastSeenIndex` — its position in that sync's encounter order (lower = newer-bookmarked, since X returns newest-first).

The sort key is `(lastSeenAt DESC, lastSeenIndex ASC)`: newer syncs first, and within a sync the earliest-encountered bookmark sorts first. A one-time backfill at sync start uses `Object.keys(manifest.bookmarks)` insertion order to give legacy entries a sensible default.

---

## Project layout

```
src/
  entrypoints/
    background.ts          # Service worker — orchestrates sync, download, snapshot
    popup.html             # Popup shell
    popup/main.tsx         # Preact entry
  popup/
    App.tsx                # Popup app (status, controls, log)
    popup.css
  explorer/                # Shared Preact components (used by snapshot build)
    App.tsx
    Header.tsx             # Toolbar with filters, sort, settings
    BookmarkCard.tsx
    GridTile.tsx
    Lightbox.tsx
    icons.tsx              # Inline SVG icon set
    util.ts                # linkify, fmtNum, fmtDate, escapeHtml
    explorer.css
  snapshot/
    index.html             # Snapshot HTML entry
    main.tsx               # Renders <App /> against either inline JSON or chrome.storage
  lib/
    types.ts               # Shared interfaces (Bookmark, Manifest, RuntimeState…)
    storage.ts             # chrome.storage helpers
    bookmarks.ts           # GraphQL fetch, response parser, helpers
    downloads.ts           # Download tracking, cancel, mapLimited
    messaging.ts           # Typed request/response message API
    raw-modules.d.ts       # `*.html?raw` module declaration
vite.snapshot.config.ts    # Standalone Vite build for the singlefile snapshot
wxt.config.ts              # WXT extension config (popup + background entries)
```

---

## Local development

```bash
npm run dev          # Auto-launches a Chromium-based browser with the extension loaded
npm run dev:firefox  # Auto-loads as a temporary Firefox add-on
```

`npm run dev` hot-reloads on file changes. WXT auto-detects an installed Chromium browser. To pin a specific binary, create a `web-ext.config.ts`:

```ts
import { defineRunnerConfig } from "wxt";
export default defineRunnerConfig({
  binaries: { chrome: "/path/to/your/chromium-binary" },
});
```

If the dev runner doesn't work for you (Brave's strict CSP can interfere with HMR), use the `npm run build` + manual unpacked-load workflow described above.

```bash
npm run build           # Chrome → .output/chrome-mv3/
npm run build:firefox   # Firefox → .output/firefox-mv2/
npm run zip             # → .output/xshelf-<version>-chrome.zip
```

`npm run build` chains:

1. `wxt prepare` — generates `.wxt/tsconfig.json` for type-checking
2. `vite build -c vite.snapshot.config.ts` — builds the singlefile snapshot template
3. `wxt build` — bundles the extension; the SW imports the snapshot HTML as a `?raw` string

---

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Write media + the snapshot HTML to your Downloads folder |
| `downloads.open` | Open the snapshot from the popup's "Open explorer" button |
| `storage` + `unlimitedStorage` | Persist the manifest (can grow large with thousands of bookmarks) |
| `webRequest` | Observe (not modify) X's request headers to capture your session, in non-blocking mode |
| Host permissions | `x.com`, `twitter.com`, `api.x.com`, `api.twitter.com`, `pbs.twimg.com`, `video.twimg.com` only |

No content scripts, no `tabs` permission, no remote scripts, no telemetry.

---

## Built with

- [WXT](https://wxt.dev) — cross-browser extension framework (Vite under the hood)
- [Preact](https://preactjs.com) — small React-API-compatible UI library, ~3 KB
- [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) — bundles the explorer into a single self-contained HTML
- [TypeScript](https://www.typescriptlang.org/), strict mode

## License

MIT (suggested) — adjust as you prefer.

## Contributing

Issues and PRs welcome. The code is small and readable: roughly 1500 LOC TypeScript across the SW, popup, and explorer.
