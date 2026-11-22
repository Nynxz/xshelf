# Using XShelf

Start with [Getting started](../README.md#getting-started) to build the extension and back up your bookmarks.

## Firefox

Run `pnpm build:firefox` from the project directory. Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `.output/firefox-mv2/manifest.json`. Browser testing has focused on Chromium.

## Back up a profile

On X, open the profile’s main timeline to back up posts, or open its **Media** tab to focus on media. Scroll to load more results, then open the XShelf popup on that tab. The **Backup** tab detects which timeline you’re viewing.

X serves separate views within the Media tab. Open and scroll each view you want included. The popup shows which views XShelf can sync. Use **Backup → Scan options → Full scan** to look for gaps beyond a stretch of already-known posts.

Sync saves post metadata. Review the media queue and select **Download all** to save the files.

## Browse the archive

Open the Explorer from the popup or open `Downloads/xshelf/index.html` directly. Click the XShelf mark to return to the top of the unfiltered **Wall**. **Back to top** keeps your current view and filters.

- **Wall** supports rows, masonry, and a square grid. **Feed** shows posts with their original text. **People** groups posts and media by author.
- Search by author or post text, and filter by source and media type. Wall and Feed can sort by saved date, posted date, or likes. Saved order is estimated from the bookmarks timeline.
- In the lightbox, use the edges or arrow keys to browse. Toggle the preview rail with **Thumbnails**, use **Details** or `I` for post information, press `Z` to zoom, and press `Esc` to close.

To update saved pages after installing a new build, use **Settings → Rebuild Explorer**. Click **Archive path** in Settings to copy the folder location after your first backup.

Keep the archive folder together if you move it. The Explorer reads its data and media using paths relative to the HTML files.

```text
xshelf/
├── index.html             # Explorer for all sources
├── classic.html           # Classic Explorer
├── bookmarks/
│   ├── data.js
│   └── explorer.html
├── users/<handle>/
│   ├── data.js
│   └── explorer.html
└── media/<handle>/        # Shared photos and videos
```

## Check for missing files

Select **Check files on disk** in the Explorer to scan the current view. To queue repairs, save the resync file, import it under **Sources → Import missing list…**, then select **Download all** in **Backup**.

## Permissions

| Permission | Used for |
| --- | --- |
| `downloads` and `downloads.open` | Save archive files and open the Explorer. |
| `storage` and `unlimitedStorage` | Keep metadata, settings, and captured session information in local extension storage. |
| `webRequest` | Observe X request headers for session and timeline capture. |
| X, Twitter, and their media host permissions | Sync timelines and download photos and videos. |

Backup and download leave your bookmarks intact. **Cleanup** can remove bookmarks from your X account after you preview and confirm a batch.
