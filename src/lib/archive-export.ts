// Built by the standalone Vite entries. Importing the HTML as text keeps
// the exported Explorers self-contained apart from their local archive data.
import snapshotTemplate from "../snapshot/dist/index.html?raw";
import masterTemplate from "../master/dist/index.html?raw";
import shelfTemplate from "../shelf/dist/index.html?raw";
import { downloadFile } from "./downloads";
import { listSources, loadManifest } from "./storage";
import { sourceDiskPath, sourceUsername } from "./types";
import type { CrawlManifest, Manifest, SourceKey } from "./types";
import { computeContentHash } from "./users";

function dataUrl(mimeType: string, text: string): string {
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;
}

function filenameTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z");
}

function sortedSourceBookmarks(manifest: Manifest) {
  return Object.values(manifest.bookmarks).sort((a, b) => {
    const ta = a.lastSeenAt ? Date.parse(a.lastSeenAt) || 0 : 0;
    const tb = b.lastSeenAt ? Date.parse(b.lastSeenAt) || 0 : 0;
    if (tb !== ta) return tb - ta;
    return (a.lastSeenIndex ?? 1e9) - (b.lastSeenIndex ?? 1e9);
  });
}

export function createArchiveWriter(appendLog: (message: string) => void) {
  /**
   * Write a per-crawl manifest for a user-archive source. Lives at
   *   <folder>/users/<handle>/crawls/<iso>.json
   * The hash covers the sorted post IDs so crawls can be compared by membership.
   */
  async function writeCrawlManifest(
    folder: string,
    manifest: Manifest,
    finishedAtIso: string,
    pages: number,
    incomplete: boolean,
  ): Promise<void> {
    const handle = sourceUsername(manifest.source);
    if (!handle) return;
    try {
      const ids = Object.keys(manifest.bookmarks);
      const sortedIds = [...ids].sort();
      const contentHash = await computeContentHash(sortedIds);
      const crawl: CrawlManifest = {
        version: 1,
        source: manifest.source,
        username: handle,
        crawledAt: finishedAtIso,
        tweetCount: ids.length,
        tweetIdMin: sortedIds[0] ?? null,
        tweetIdMax: sortedIds[sortedIds.length - 1] ?? null,
        contentHash,
        pages,
        stoppedEarly: incomplete,
      };
      const json = JSON.stringify(crawl, null, 2);
      const path = `${folder}/users/${handle}/crawls/${filenameTimestamp(finishedAtIso)}.json`;
      await downloadFile(dataUrl("application/json", json), path);
      appendLog(
        `Crawl manifest: ${ids.length} tweets, sha256=${contentHash.slice(0, 12)}…`,
      );
    } catch (e) {
      appendLog(`Crawl manifest write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Per-source `data.js`: an IIFE that registers this source's payload with
   * `window.xshelf` so the master xshelf/index.html can pick it up via a
   * `<script src>` tag. Same shape as the inline JSON in per-source
   * explorer.html, just delivered via JS rather than JSON-in-HTML so we can
   * use it cross-document (file:// can't fetch).
   */
  async function writeSourceDataJs(
    folder: string,
    manifest: Manifest,
  ): Promise<void> {
    try {
      const sourcePath = sourceDiskPath(manifest.source);
      const sortedBookmarks = sortedSourceBookmarks(manifest);
      const payload = {
        source: manifest.source,
        exportedAt: new Date().toISOString(),
        count: sortedBookmarks.length,
        lastRun: manifest.lastRun,
        bookmarks: sortedBookmarks,
      };
      const sourceJson = JSON.stringify(manifest.source);
      const payloadJson = JSON.stringify(payload);
      const js =
        `(function(){var w=window;` +
        `if(!w.xshelf)w.xshelf={sources:{},sourceList:[]};` +
        `w.xshelf.sources[${sourceJson}]=${payloadJson};` +
        `if(w.xshelf.sourceList.indexOf(${sourceJson})<0)w.xshelf.sourceList.push(${sourceJson});` +
        `})();`;
      await downloadFile(
        dataUrl("application/javascript", js),
        `${folder}/${sourcePath}/data.js`,
      );
    } catch (e) {
      appendLog(`data.js write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Cross-source explorers: xshelf/index.html (the shelf explorer, from
   * vite.shelf.config.ts) and xshelf/classic.html (the original master
   * explorer, vite.master.config.ts). Both are singlefile Preact bundles
   * with `<script src>` tags injected for every known source's data.js.
   * Rewritten on every sync so newly-added sources appear automatically.
   *
   * The injection point is between two HTML comment sentinels in the
   * built template:
   *   <!-- xshelf-source-scripts-start --><!-- xshelf-source-scripts-end -->
   */
  async function writeMasterIndex(folder: string): Promise<void> {
    try {
      const sources = await listSources();
      if (!sources.length) return; // nothing to aggregate yet
      const tags = sources
        .map((s) => `<script src="${sourceDiskPath(s)}/data.js"></script>`)
        .join("\n    ");
      const inject = (template: string) =>
        template.replace(
          /<!--\s*xshelf-source-scripts-start\s*-->[\s\S]*?<!--\s*xshelf-source-scripts-end\s*-->/,
          `<!-- xshelf-source-scripts-start -->\n    ${tags}\n    <!-- xshelf-source-scripts-end -->`,
        );
      await downloadFile(dataUrl("text/html", inject(shelfTemplate)), `${folder}/index.html`);
      await downloadFile(dataUrl("text/html", inject(masterTemplate)), `${folder}/classic.html`);
      appendLog(
        `Explorer regenerated (${sources.length} source${sources.length === 1 ? "" : "s"}): index.html + classic.html.`,
      );
    } catch (e) {
      appendLog(`Master index write failed: ${(e as Error).message}`);
    }
  }

  async function writeSnapshot(
    folder: string,
    manifest: Manifest,
  ): Promise<void> {
    try {
      const sourcePath = sourceDiskPath(manifest.source); // "bookmarks" or "users/<handle>"
      const html = snapshotTemplate;

      // Relative path from this explorer.html's directory back up to the
      // shared `<folder>/media/` tree. Bookmarks lives one level deep
      // (`bookmarks/explorer.html` → `../media/`); user archives live two
      // levels deep (`users/<h>/explorer.html` → `../../media/`).
      const depth = sourcePath.split("/").length;
      const mediaPathPrefix = "../".repeat(depth) + "media/";

      const sortedBookmarks = sortedSourceBookmarks(manifest);

      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        count: sortedBookmarks.length,
        lastRun: manifest.lastRun,
        source: manifest.source,
        mediaPathPrefix,
        bookmarks: sortedBookmarks,
      }).replace(/</g, "\\u003c");
      const dataTag = `<script id="xbd-data" type="application/json">${payload}</script>`;

      // Insert just before </body> so it's parsed before the main bundle runs.
      const injected = html.includes("</body>")
        ? html.replace("</body>", () => `${dataTag}</body>`)
        : html + dataTag;

      // Per-source self-contained explorer. e.g.:
      //   xshelf/bookmarks/explorer.html
      //   xshelf/users/elonmusk/explorer.html
      await downloadFile(
        dataUrl("text/html", injected),
        `${folder}/${sourcePath}/explorer.html`,
      );
    } catch (e) {
      appendLog(`Snapshot write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Write a JSON backup of a source's manifest to
   *   <folder>/backups/<source>-<iso>.json
   * Pure read-side: never touches the in-memory manifest, never touches media
   * files. Used as a safety net before any destructive operation (unbookmark
   * cleanup), and exposed as a standalone action in the Cleanup tab.
   */
  async function backupManifestToDisk(
    folder: string,
    source: SourceKey,
  ): Promise<string> {
    const manifest = await loadManifest(source);
    const stamp = filenameTimestamp(new Date().toISOString());
    const sourceTag = source.replace(":", "-");
    const path = `${folder}/backups/${sourceTag}-${stamp}.json`;
    const json = JSON.stringify(manifest, null, 2);
    await downloadFile(dataUrl("application/json", json), path, "uniquify");
    appendLog(
      `Backup written: ${path} (${Object.keys(manifest.bookmarks).length} entries)`,
    );
    return path;
  }

  async function writeSource(folder: string, manifest: Manifest): Promise<void> {
    await writeSnapshot(folder, manifest);
    await writeSourceDataJs(folder, manifest);
  }

  return { writeSource, writeSourceDataJs, writeMasterIndex, writeCrawlManifest, backupManifestToDisk };
}
