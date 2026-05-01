import { defineBackground } from "wxt/sandbox";
import { SW_VERSION } from "../lib/messaging";
// The on-disk explorer snapshot template: a self-contained HTML built by
// `npm run build:snapshot` (vite + vite-plugin-singlefile). Vite's `?raw`
// suffix imports the file's contents as a string at build time, so the
// finished SW bundle has the full template baked in. We avoid using public/
// because WXT was reprocessing public/*.html as additional entries, which
// undid the singlefile inlining.
import snapshotTemplate from "../snapshot/dist/index.html?raw";
import type {
  Bookmark,
  Captured,
  Manifest,
  PendingMediaItem,
  PendingSummary,
  RuntimeState,
  SourceKey,
  SyncOptions,
} from "../lib/types";
import { sourceDiskPath } from "../lib/types";
import {
  clearManifest,
  clearPending,
  freshRuntime,
  loadCaptured,
  loadManifest,
  loadPending,
  loadRuntime,
  migrateLegacyManifest,
  saveCaptured,
  saveManifest,
  savePending,
  saveRuntime,
  wipeAll,
} from "../lib/storage";
import {
  allMediaDownloaded,
  extFromUrl,
  extractEntries,
  fetchBookmarksPage,
  parseTweetEntry,
  sanitizeUsername,
} from "../lib/bookmarks";
import {
  cancelAllDownloads,
  downloadFile,
  existsByUrl,
  mapLimited,
} from "../lib/downloads";

export default defineBackground({
  type: "module",
  main() {
    // === STATE ===
    let runtime: RuntimeState = freshRuntime();
    let pendingMedia: PendingMediaItem[] = [];
    let captured: Captured = { auth: null, queryId: null, operation: null };
    let cancelFlag = false;

    // === PERSISTENCE (throttled) ===
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let persistQueued = false;

    async function persist(): Promise<void> {
      persistQueued = true;
      if (persistTimer) return;
      persistTimer = setTimeout(flushPersist, 200);
    }

    async function flushPersist(): Promise<void> {
      persistTimer = null;
      if (!persistQueued) return;
      persistQueued = false;
      const snap = runtime;
      try {
        await saveRuntime(snap);
        chrome.runtime
          .sendMessage({ type: "stateUpdate", state: snap })
          .catch(() => {});
      } catch {}
    }

    async function persistNow(): Promise<void> {
      persistQueued = false;
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      await saveRuntime(runtime);
      chrome.runtime
        .sendMessage({ type: "stateUpdate", state: runtime })
        .catch(() => {});
    }

    function appendLog(line: string): void {
      const ts = new Date().toLocaleTimeString();
      runtime.log.push(`[${ts}] ${line}`);
      while (runtime.log.length > 120) runtime.log.shift();
    }

    function recomputeSummary(): void {
      const byUser: PendingSummary["byUser"] = {};
      let photos = 0;
      let videos = 0;
      const tweetIds = new Set<string>();
      for (const p of pendingMedia) {
        tweetIds.add(p.tweetId);
        const u = p.username || "unknown";
        if (!byUser[u]) byUser[u] = { count: 0, photos: 0, videos: 0 };
        byUser[u].count++;
        if (p.kind === "video") {
          byUser[u].videos++;
          videos++;
        } else {
          byUser[u].photos++;
          photos++;
        }
      }
      runtime.pendingSummary = {
        count: pendingMedia.length,
        tweetCount: tweetIds.size,
        photoCount: photos,
        videoCount: videos,
        byUser,
      };
    }

    // === STARTUP ===
    async function loadPersisted(): Promise<void> {
      // One-shot migration from the v1 single-manifest layout to v2 multi-source.
      // Idempotent — flagged in storage so it only runs once per profile.
      try {
        const result = await migrateLegacyManifest();
        if (result.migrated) {
          appendLog(`Migrated ${result.count} legacy bookmarks to v2 multi-source layout.`);
        }
      } catch (e) {
        appendLog(`Migration warning: ${(e as Error).message}`);
      }

      const stored = await loadRuntime();
      if (stored) {
        runtime = { ...freshRuntime(), ...stored };
      }
      pendingMedia = await loadPending();
      recomputeSummary();
      captured = await loadCaptured();
      // Discard a previously-captured folder-management operation; only the timeline op is useful.
      if (
        captured.operation &&
        (/BookmarkFolders/i.test(captured.operation) || /UpdateBookmark/i.test(captured.operation))
      ) {
        captured.operation = null;
        captured.queryId = null;
        await saveCaptured(captured);
      }

      if (runtime.status === "syncing" || runtime.status === "cancelling") {
        runtime.status = "interrupted";
        runtime.errorMessage =
          "Service worker was restarted mid-sync. Click Start sync to resume.";
        appendLog(runtime.errorMessage);
        await persistNow();
      } else if (runtime.status === "downloading") {
        if (pendingMedia.length > 0) {
          runtime.status = "ready";
          runtime.errorMessage = null;
          appendLog(
            `Service worker restarted mid-download. ${pendingMedia.length} items still pending — click Download to resume.`,
          );
        } else {
          runtime.status = "done";
        }
        await persistNow();
      }
    }

    // === CAPTURE (auth + endpoint via webRequest) ===
    chrome.webRequest.onSendHeaders.addListener(
      (details) => {
        let touched = false;
        const auth = { ...(captured.auth ?? {}) } as { authorization?: string; csrf?: string };
        for (const h of details.requestHeaders ?? []) {
          const name = h.name.toLowerCase();
          if (name === "authorization") {
            auth.authorization = h.value;
            touched = true;
          } else if (name === "x-csrf-token") {
            auth.csrf = h.value;
            touched = true;
          }
        }
        if (touched && auth.authorization && auth.csrf) {
          captured.auth = { authorization: auth.authorization, csrf: auth.csrf };
        }
        const m = details.url.match(
          /\/i\/api\/graphql\/([^/?]+)\/([^/?]*Bookmark[^/?]*)/i,
        );
        if (m) {
          const op = m[2];
          const isFolderOnly =
            /BookmarkFolders/i.test(op) ||
            /CreateBookmarkFolder/i.test(op) ||
            /DeleteBookmarkFolder/i.test(op) ||
            /UpdateBookmark/i.test(op);
          const isCanonical = /^Bookmarks$/.test(op);
          if (!isFolderOnly) {
            if (
              isCanonical ||
              !captured.operation ||
              /BookmarkFolders/i.test(captured.operation)
            ) {
              captured.queryId = m[1];
              captured.operation = op;
              touched = true;
            }
          }
        }
        if (touched) saveCaptured(captured);
      },
      {
        urls: [
          "https://x.com/i/api/*",
          "https://twitter.com/i/api/*",
          "https://api.x.com/*",
          "https://api.twitter.com/*",
        ],
      },
      ["requestHeaders", "extraHeaders"],
    );

    // === RUN: SYNC PHASE ===
    async function runSync(options: SyncOptions): Promise<void> {
      // Phase 0: only bookmarks source. Phase 1 will parameterize this on the run.
      const source: SourceKey = "bookmarks";
      if (
        runtime.status === "syncing" ||
        runtime.status === "downloading" ||
        runtime.status === "cancelling"
      )
        return;
      cancelFlag = false;
      // Single timestamp for THIS sync — every visited bookmark gets the same lastSeenAt
      // so the (lastSeenAt DESC, lastSeenIndex ASC) sort is determined purely by index.
      const syncStartedIso = new Date().toISOString();
      runtime = {
        ...freshRuntime(),
        status: "syncing",
        startedAt: syncStartedIso,
        options,
      };
      pendingMedia = [];
      await clearPending();
      appendLog(
        `Sync → ${options.folder}/  (maxPages=${options.maxPages}, incremental=${options.incremental})`,
      );
      await persist();

      try {
        if (!captured.auth?.authorization || !captured.auth?.csrf) {
          throw new Error(
            "No auth captured yet. Open https://x.com/i/bookmarks (or refresh it) so the extension can observe the request.",
          );
        }
        if (!captured.queryId || !captured.operation) {
          throw new Error(
            "No bookmark endpoint captured yet. Open https://x.com/i/bookmarks and scroll once.",
          );
        }
        if (
          /BookmarkFolders/i.test(captured.operation) ||
          /UpdateBookmark/i.test(captured.operation)
        ) {
          throw new Error(
            `Captured the wrong endpoint (${captured.operation}). Open https://x.com/i/bookmarks (the main list, not a folder) and scroll once.`,
          );
        }
        appendLog(`Endpoint: ${captured.operation} (queryId=${captured.queryId})`);
        await persist();

        const manifest = await loadManifest(source);
        runtime.totalKnown = Object.keys(manifest.bookmarks).length;
        appendLog(`History: ${runtime.totalKnown} bookmarks already tracked.`);
        await persist();

        // ---- One-time backfill of lastSeenIndex (insertion order = original encounter order)
        {
          const ids = Object.keys(manifest.bookmarks);
          const needsBackfill = ids.some(
            (id) => manifest.bookmarks[id].lastSeenIndex == null,
          );
          if (needsBackfill) {
            appendLog("Backfilling sort ordering for legacy entries…");
            let backfilled = 0;
            ids.forEach((id, idx) => {
              const b = manifest.bookmarks[id];
              if (b.lastSeenIndex == null) {
                b.lastSeenIndex = idx + 1;
                if (!b.lastSeenAt) {
                  b.lastSeenAt = b.firstSeenAt || "1970-01-01T00:00:00.000Z";
                }
                backfilled++;
              }
            });
            if (backfilled) appendLog(`Backfilled ${backfilled} entries.`);
            await saveManifest(manifest);
          }
        }

        // ---- Audit pass against Chrome download history
        if (options.incremental && runtime.totalKnown > 0) {
          runtime.currentPhase = "audit";
          await persist();
          const reconciled = await auditAgainstChromeDownloads(manifest);
          if (reconciled > 0) {
            appendLog(
              `Audit reconciled ${reconciled} files (already on disk; won't re-download).`,
            );
            await saveManifest(manifest);
          } else {
            appendLog("Audit: nothing new to reconcile.");
          }
          await persist();
        }

        // ---- Pagination
        runtime.currentPhase = "fetch";
        await persist();
        let cursor: string | null = null;
        const queuedKey = new Set<string>();
        let consecutiveKnown = 0;
        let stoppedEarly = false;
        const earlyStopAfter = options.earlyStopAfter ?? 30;
        let syncEncounterIndex = 0;

        while (runtime.pageCount < options.maxPages) {
          if (cancelFlag) break;
          runtime.pageCount++;
          appendLog(`Page ${runtime.pageCount}…`);
          await persist();

          let json: unknown;
          try {
            json = await fetchBookmarksPage({
              host: "x.com",
              queryId: captured.queryId,
              operation: captured.operation,
              cursor,
              captured,
            });
          } catch (e) {
            const msg = (e as Error).message ?? String(e);
            if (/HTTP 404/.test(msg) && /Query not found/i.test(msg)) {
              appendLog(
                "404 — endpoint rotated. Refresh https://x.com/i/bookmarks then click Start sync again.",
              );
            }
            throw e;
          }
          const { entries, nextCursor } = extractEntries(json);
          let newOnPage = 0;

          for (const entry of entries) {
            const tweet = parseTweetEntry(entry);
            if (!tweet) continue;
            runtime.totalSeen++;
            const existing = manifest.bookmarks[tweet.id] as Bookmark | undefined;
            const nowIso = syncStartedIso;

            if (existing && options.incremental && allMediaDownloaded(existing)) {
              syncEncounterIndex++;
              existing.lastSeenAt = nowIso;
              existing.lastSeenIndex = syncEncounterIndex;
              existing.replyCount = tweet.replyCount;
              existing.retweetCount = tweet.retweetCount;
              existing.favoriteCount = tweet.favoriteCount;
              existing.quoteCount = tweet.quoteCount;
              consecutiveKnown++;
              if (consecutiveKnown >= earlyStopAfter) {
                stoppedEarly = true;
                appendLog(
                  `${consecutiveKnown} consecutive known tweets — stopping early.`,
                );
                break;
              }
            } else {
              consecutiveKnown = 0;
              const mergedMedia = tweet.media.map((m, i) => {
                const prior = existing?.media?.[i];
                return {
                  kind: m.kind,
                  index: m.index,
                  url: m.url,
                  downloaded: !!prior?.downloaded,
                };
              });
              syncEncounterIndex++;
              const merged: Bookmark = {
                ...tweet,
                media: mergedMedia,
                firstSeenAt: existing ? existing.firstSeenAt : nowIso,
                lastSeenAt: nowIso,
                lastSeenIndex: syncEncounterIndex,
              };
              manifest.bookmarks[tweet.id] = merged;
              if (!existing) {
                runtime.newCount++;
                newOnPage++;
              }
              for (const m of mergedMedia) {
                if (m.downloaded) continue;
                const key = `${merged.id}_${m.index}`;
                if (queuedKey.has(key)) continue;
                queuedKey.add(key);
                pendingMedia.push({
                  tweetId: merged.id,
                  username: merged.username,
                  mediaIndex: m.index,
                  kind: m.kind,
                  url: m.url,
                });
              }
            }
          }

          runtime.totalKnown = Object.keys(manifest.bookmarks).length;
          appendLog(
            `Page ${runtime.pageCount}: seen=${runtime.totalSeen}, new=${runtime.newCount}, +${newOnPage} this page, pending=${pendingMedia.length}.`,
          );
          recomputeSummary();
          await persist();
          await saveManifest(manifest);

          if (stoppedEarly) break;
          if (!nextCursor || nextCursor === cursor || entries.length === 0) break;
          cursor = nextCursor;
          await sleep(800 + Math.random() * 600);
        }

        // ---- Pre-flight: drop pending entries already in Chrome's download history
        if (options.incremental && pendingMedia.length) {
          runtime.currentPhase = "preflight";
          appendLog(
            `Pre-flight: checking ${pendingMedia.length} URLs against download history…`,
          );
          await persist();
          const results = await mapLimited(
            pendingMedia,
            4,
            (p) => (cancelFlag ? Promise.resolve(false) : existsByUrl(p.url)),
            (done, total) => {
              appendLog(`Pre-flight progress: ${done}/${total}`);
              persist();
            },
          );
          let skipped = 0;
          const keptSkipFlags = new Array(pendingMedia.length).fill(false);
          for (let i = 0; i < pendingMedia.length; i++) {
            if (results[i]) {
              const item = pendingMedia[i];
              const t = manifest.bookmarks[item.tweetId];
              const m = t?.media?.find((mm) => mm.index === item.mediaIndex);
              if (m) m.downloaded = true;
              keptSkipFlags[i] = true;
              skipped++;
            }
          }
          pendingMedia = pendingMedia.filter((_, i) => !keptSkipFlags[i]);
          runtime.mediaSkipped = skipped;
          if (skipped > 0) {
            appendLog(`Pre-flight skipped ${skipped} URLs already on disk.`);
            await saveManifest(manifest);
          }
          recomputeSummary();
          await persist();
        }

        recomputeSummary();
        await savePending(pendingMedia);

        manifest.lastRun = {
          finishedAt: new Date().toISOString(),
          pages: runtime.pageCount,
          seen: runtime.totalSeen,
          newCount: runtime.newCount,
          stoppedEarly,
          phase: "sync",
        };
        await saveManifest(manifest);

        // Write the on-disk snapshot so the user has an offline-viewable HTML
        // alongside their media files. Done after sync (even before the user
        // accepts the download phase) so the index reflects current manifest state.
        await writeSnapshot(options.folder, manifest);

        runtime.totalKnown = Object.keys(manifest.bookmarks).length;
        runtime.finishedAt = new Date().toISOString();
        runtime.currentPhase = null;

        if (cancelFlag) {
          runtime.status = "cancelled";
          appendLog(`Cancelled during sync. ${pendingMedia.length} items in pending list.`);
        } else if (pendingMedia.length === 0) {
          runtime.status = "done";
          appendLog(
            `Sync done. Nothing new to download. seen=${runtime.totalSeen}, total=${runtime.totalKnown}.`,
          );
        } else {
          runtime.status = "ready";
          appendLog(
            `Sync done. ${pendingMedia.length} media items pending. Click Download to fetch, or Discard.`,
          );
        }
        await persistNow();
      } catch (e) {
        runtime.status = "error";
        runtime.errorMessage = (e as Error).message ?? String(e);
        runtime.finishedAt = new Date().toISOString();
        runtime.currentPhase = null;
        appendLog(`Error: ${runtime.errorMessage}`);
        await persistNow();
      }
    }

    // === RUN: DOWNLOAD PHASE ===
    async function runDownload(): Promise<void> {
      if (runtime.status !== "ready") return;
      if (pendingMedia.length === 0) {
        runtime.status = "done";
        await persistNow();
        return;
      }
      cancelFlag = false;
      runtime.status = "downloading";
      runtime.currentPhase = "download";
      runtime.mediaTotal = pendingMedia.length;
      runtime.mediaDone = 0;
      runtime.mediaErrored = 0;
      runtime.startedAt = new Date().toISOString();
      appendLog(`Download → ${pendingMedia.length} media items.`);
      await persist();

      // Phase 0: hard-coded bookmarks. Phase 1 will look up the active source
      // from runtime.options once user-archive sources exist.
      const source: SourceKey = "bookmarks";
      const folder = runtime.options?.folder ?? "xshelf";
      const manifest = await loadManifest(source);

      try {
        const sourcePath = sourceDiskPath(source);
        while (pendingMedia.length > 0) {
          if (cancelFlag) break;
          const item = pendingMedia[0];
          const ext = item.kind === "video" ? "mp4" : extFromUrl(item.url) ?? "jpg";
          const safeUser = sanitizeUsername(item.username);
          // <folder>/<sourcePath>/media/<author>/<tweetId>_<n>.<ext>
          // e.g. xshelf/bookmarks/media/elonmusk/1234_0.jpg
          //      xshelf/users/naval/media/<id>_<n>.jpg (in phase 1)
          const filename = `${folder}/${sourcePath}/media/${safeUser}/${item.tweetId}_${item.mediaIndex}.${ext}`;
          try {
            await downloadFile(item.url, filename, "overwrite");
            const t = manifest.bookmarks[item.tweetId];
            const m = t?.media?.find((mm) => mm.index === item.mediaIndex);
            if (m) m.downloaded = true;
          } catch (e) {
            runtime.mediaErrored++;
            appendLog(
              `Failed: ${item.tweetId}_${item.mediaIndex} — ${(e as Error).message}`,
            );
          }
          pendingMedia.shift();
          runtime.mediaDone++;
          if (runtime.mediaDone % 5 === 0) {
            recomputeSummary();
            persist();
          }
          if (runtime.mediaDone % 25 === 0 || pendingMedia.length === 0) {
            await savePending(pendingMedia);
            await saveManifest(manifest);
          }
        }
        recomputeSummary();
        await savePending(pendingMedia);
        await saveManifest(manifest);
        // Re-write the snapshot now that media `downloaded` flags are flipped.
        await writeSnapshot(folder, manifest);

        runtime.totalKnown = Object.keys(manifest.bookmarks).length;
        runtime.finishedAt = new Date().toISOString();
        runtime.currentPhase = null;
        if (cancelFlag) {
          runtime.status = pendingMedia.length ? "ready" : "cancelled";
          appendLog(`Cancelled during download. ${pendingMedia.length} still pending.`);
        } else {
          runtime.status = "done";
          appendLog(
            `Download done. ${runtime.mediaDone} processed, ${runtime.mediaErrored} errored, total=${runtime.totalKnown}.`,
          );
        }
        await persistNow();
      } catch (e) {
        runtime.status = "error";
        runtime.errorMessage = (e as Error).message ?? String(e);
        runtime.finishedAt = new Date().toISOString();
        runtime.currentPhase = null;
        appendLog(`Error: ${runtime.errorMessage}`);
        await persistNow();
      }
    }

    /**
     * Fetches the extension's built `explorer.html` (which is self-contained thanks
     * to vite-plugin-singlefile), injects the user's bookmarks as inline JSON,
     * and writes the result to ~/Downloads/<folder>/explorer.html. The snapshot
     * sits next to the media folder, so relative `media/<user>/<id>.jpg` paths
     * resolve from `file://` and the user gets full media playback offline.
     */
    async function writeSnapshot(folder: string, manifest: Manifest): Promise<void> {
      try {
        const sourcePath = sourceDiskPath(manifest.source);
        const html = snapshotTemplate;

        const sortedBookmarks = Object.values(manifest.bookmarks).sort((a, b) => {
          const ta = a.lastSeenAt ? Date.parse(a.lastSeenAt) || 0 : 0;
          const tb = b.lastSeenAt ? Date.parse(b.lastSeenAt) || 0 : 0;
          if (tb !== ta) return tb - ta;
          return (a.lastSeenIndex ?? 1e9) - (b.lastSeenIndex ?? 1e9);
        });

        const payload = JSON.stringify({
          exportedAt: new Date().toISOString(),
          count: sortedBookmarks.length,
          lastRun: manifest.lastRun,
          bookmarks: sortedBookmarks,
        }).replace(/<\/script/gi, "<\\/script");
        const dataTag = `<script id="xbd-data" type="application/json">${payload}</script>`;

        // Insert just before </body> so it's parsed before the main bundle runs.
        const injected = html.includes("</body>")
          ? html.replace("</body>", `${dataTag}</body>`)
          : html + dataTag;

        const dataUrl =
          "data:text/html;charset=utf-8," + encodeURIComponent(injected);
        // Per-source self-contained explorer. e.g.:
        //   xshelf/bookmarks/explorer.html
        //   xshelf/users/elonmusk/explorer.html (in phase 1)
        // Phase 2 will add a master xshelf/index.html that aggregates sources.
        await downloadFile(dataUrl, `${folder}/${sourcePath}/explorer.html`, "overwrite");
      } catch (e) {
        appendLog(`Snapshot write failed: ${(e as Error).message}`);
      }
    }

    async function auditAgainstChromeDownloads(manifest: Manifest): Promise<number> {
      const pending: Array<{ tweetId: string; mediaIndex: number; url: string }> = [];
      for (const id of Object.keys(manifest.bookmarks)) {
        const t = manifest.bookmarks[id];
        for (const m of t.media ?? []) {
          if (!m.downloaded && m.url) {
            pending.push({ tweetId: id, mediaIndex: m.index, url: m.url });
          }
        }
      }
      if (!pending.length) return 0;
      appendLog(`Auditing ${pending.length} URLs…`);
      await persist();
      let reconciled = 0;
      const results = await mapLimited(
        pending,
        4,
        (p) => (cancelFlag ? Promise.resolve(false) : existsByUrl(p.url)),
        (done, total) => {
          appendLog(`Audit progress: ${done}/${total}`);
          persist();
        },
      );
      for (let i = 0; i < pending.length; i++) {
        if (results[i]) {
          const t = manifest.bookmarks[pending[i].tweetId];
          const m = t?.media?.find((mm) => mm.index === pending[i].mediaIndex);
          if (m) {
            m.downloaded = true;
            reconciled++;
          }
        }
      }
      return reconciled;
    }

    // === MESSAGE API ===
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        try {
          switch (msg.type) {
            case "getRunState": {
              sendResponse({
                ok: true,
                version: SW_VERSION,
                state: runtime,
                captured: {
                  hasAuth: !!(
                    captured.auth?.authorization && captured.auth?.csrf
                  ),
                  queryId: captured.queryId,
                  operation: captured.operation,
                },
              });
              return;
            }
            case "startSync": {
              if (
                runtime.status === "syncing" ||
                runtime.status === "downloading" ||
                runtime.status === "cancelling"
              ) {
                sendResponse({ ok: false, error: "Already running" });
                return;
              }
              runSync(msg.options);
              sendResponse({ ok: true });
              return;
            }
            case "startDownload": {
              if (runtime.status !== "ready") {
                sendResponse({
                  ok: false,
                  error: `Cannot start download from status "${runtime.status}".`,
                });
                return;
              }
              runDownload();
              sendResponse({ ok: true });
              return;
            }
            case "discardPending": {
              await clearPending();
              pendingMedia = [];
              recomputeSummary();
              runtime.status = "idle";
              appendLog("Pending list discarded.");
              await persistNow();
              sendResponse({ ok: true });
              return;
            }
            case "cancelBackup": {
              if (
                runtime.status === "syncing" ||
                runtime.status === "downloading" ||
                runtime.status === "cancelling"
              ) {
                cancelFlag = true;
                runtime.status = "cancelling";
                appendLog("Cancel requested.");
                await persistNow();
                await cancelAllDownloads();
              }
              sendResponse({ ok: true });
              return;
            }
            case "clearManifest": {
              // Phase 0: only the bookmarks source. Phase 2 will let the user
              // choose which source(s) to clear from the popup.
              await clearManifest("bookmarks");
              sendResponse({ ok: true });
              return;
            }
            case "getManifest": {
              const m = await loadManifest("bookmarks");
              sendResponse({ ok: true, manifest: m });
              return;
            }
            case "wipeAll": {
              await wipeAll();
              runtime = freshRuntime();
              pendingMedia = [];
              captured = { auth: null, queryId: null, operation: null };
              appendLog("All extension data wiped.");
              await persistNow();
              sendResponse({ ok: true });
              return;
            }
            // (openExplorer is handled by the popup directly via chrome.downloads.open;
            // it needs the click's user gesture, which doesn't survive an SW round-trip.)
            default:
              sendResponse({ ok: false, error: "unknown message" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message ?? String(e) });
        }
      })();
      return true;
    });

    // === BOOTSTRAP ===
    loadPersisted();
    chrome.runtime.onStartup.addListener(loadPersisted);
    chrome.runtime.onInstalled.addListener(loadPersisted);
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
