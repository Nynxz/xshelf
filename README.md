# X Bookmark Downloader

A browser extension that backs up your X / Twitter bookmarks (text, full-resolution media, metadata) and renders a local explorer for browsing them. **Read-only** — never modifies the bookmarks on your account.

## Status

- Built with **WXT + Preact + TypeScript**.
- Targets Chrome and Firefox (`browser.*` API via WXT).
- Runs the long-lived sync/download in the background service worker so the popup can be closed and reopened without losing progress.

## Local development

```bash
npm install
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

If the dev runner doesn't work for you, `npm run build` produces an unpacked extension at `.output/chrome-mv3/` — load it manually via your browser's extensions page → Developer mode → Load unpacked.

Open `https://x.com/i/bookmarks` and scroll once so the extension can capture your session via webRequest, then click the extension icon → **Start sync**.

## Build

```bash
npm run build           # Chrome → .output/chrome-mv3/
npm run build:firefox   # Firefox → .output/firefox-mv2/
npm run zip             # → .output/x-bookmark-downloader-<version>-chrome.zip
npm run zip:firefox
```

## Project layout

```
src/
  entrypoints/
    background.ts          # Service worker: orchestrates sync + download
    popup.html             # Popup shell
    popup/main.tsx         # Preact entry
    explorer.html          # Local explorer shell
    explorer/main.tsx      # Preact entry
  popup/
    App.tsx                # Popup app (status, controls, log)
    popup.css
  explorer/
    App.tsx                # Explorer app (filters, list/grid, lightbox)
    Header.tsx             # Toolbar (search, filters, sort, view toggle)
    BookmarkCard.tsx       # List view card
    GridTile.tsx           # Grid view tile
    Lightbox.tsx           # Modal with media + tweet text
    util.ts                # linkify, fmtNum, fmtDate, escapeHtml
    explorer.css
  lib/
    types.ts               # Shared interfaces (Bookmark, Manifest, RuntimeState…)
    storage.ts              # chrome.storage.local helpers
    bookmarks.ts            # GraphQL fetch, response parser, helpers
    downloads.ts            # Download tracking, cancel, mapLimited
    messaging.ts            # Typed request/response message API
```

## How it works (high level)

1. **Capture** — `chrome.webRequest.onSendHeaders` watches x.com / api.x.com for the live `Authorization` and `x-csrf-token` headers, plus the rotating `/i/api/graphql/<id>/Bookmarks` query-id and operation name. Only the canonical `Bookmarks` op is accepted (folder-management ops are rejected).
2. **Sync** — paginates `Bookmarks` via fetch + captured headers + the user's existing session cookies (`credentials: "include"`), parses each tweet, merges into `chrome.storage.local["xbd_manifest_v1"]`. Audits the manifest against `chrome.downloads.search` history (concurrency-capped) so files already on disk aren't re-fetched. Writes a pending list (`xbd_pending_v1`) for the user to review.
3. **Review** — popup shows totals + per-user breakdown; user picks **Download all** or **Discard**.
4. **Download** — `chrome.downloads.download` with `conflictAction: "overwrite"` for each pending item; progress and cancel work regardless of whether the popup is open.
5. **Explore** — the popup's "Open explorer" button opens `chrome-extension://…/explorer.html`, a Preact app that reads the manifest from storage and renders cards, a packed grid, search, filters, sort, and a lightbox.

## Sort key for "Newest bookmarked"

X doesn't expose a "bookmarked at" timestamp. Each visited bookmark is re-stamped with `lastSeenAt` (a single timestamp captured at sync start, identical across all bookmarks visited in that sync) and `lastSeenIndex` (the position within that sync's encounter order). The sort key is `(lastSeenAt DESC, lastSeenIndex ASC)`: newer syncs first, and within a sync the lower index (= newer-bookmarked) wins.

A one-time backfill at sync start gives a sensible default ordering to legacy entries (uses `Object.keys(manifest.bookmarks)` insertion order, which on the original sync was the same as X's newest-first response).

## Permissions

- `downloads` — write media + index files
- `storage` + `unlimitedStorage` — manifest can grow large
- `webRequest` — observe (not modify) X's request headers to capture auth + endpoint

Host permissions are scoped to `x.com`, `twitter.com`, `api.x.com`, `api.twitter.com`, `pbs.twimg.com`, `video.twimg.com`.
