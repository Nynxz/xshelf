import { defineBackground } from "wxt/sandbox";
import { SW_VERSION } from "../lib/messaging";
// The on-disk explorer snapshot template: a self-contained HTML built by
// `npm run build:snapshot` (vite + vite-plugin-singlefile). Vite's `?raw`
// suffix imports the file's contents as a string at build time, so the
// finished SW bundle has the full template baked in. We avoid using public/
// because WXT was reprocessing public/*.html as additional entries, which
// undid the singlefile inlining.
import snapshotTemplate from "../snapshot/dist/index.html?raw";
// Master-explorer template: a sidebar over BookmarkExplorer that aggregates
// every known source. Same `?raw` mechanism as the per-source snapshot.
import masterTemplate from "../master/dist/index.html?raw";
import type {
  Bookmark,
  Captured,
  CrawlManifest,
  Manifest,
  PendingMediaItem,
  PendingSummary,
  RuntimeState,
  SourceKey,
  SyncOptions,
} from "../lib/types";
import { CAPTURED_OP_NAMES, isUserSource, sourceDiskPath, sourceUsername } from "../lib/types";
import {
  clearManifest,
  clearPending,
  freshRuntime,
  listSources,
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
  existsAtPath,
  mapLimited,
} from "../lib/downloads";
import {
  computeContentHash,
  extractUserTweetsEntries,
  fetchUserByScreenName,
  fetchUserMediaPage,
  fetchUserTweetsPage,
  isRetweet,
} from "../lib/users";

export default defineBackground({
  type: "module",
  main() {
    // === STATE ===
    let runtime: RuntimeState = freshRuntime();
    let pendingMedia: PendingMediaItem[] = [];
    let captured: Captured = { auth: null, endpoints: {} };
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
        // Capture every relevant GraphQL endpoint by matching its operation name
        // against the allow-list. Each rotates independently when X redeploys.
        const m = details.url.match(/\/i\/api\/graphql\/([^/?]+)\/([^/?]+)/);
        if (m) {
          const queryId = m[1];
          const op = m[2];
          for (const target of CAPTURED_OP_NAMES) {
            if (op === target) {
              captured.endpoints[target] = { queryId };
              touched = true;
              break;
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
    /**
     * Compute the relative on-disk path a media item will be (or was) written to.
     *
     * Layout (since phase 1f): one shared media tree at `<folder>/media/<author>/`
     * regardless of which source the item belongs to. A tweet present in both
     * bookmarks AND a user archive lives once on disk; the two manifests both
     * reference the same file. Eliminates the "same-URL-different-path" class
     * of bug from earlier phases entirely.
     */
    function expectedMediaPath(
      folder: string,
      _source: SourceKey,
      tweetId: string,
      username: string,
      mediaIndex: number,
      kind: PendingMediaItem["kind"],
      url: string,
    ): string {
      const safeUser = sanitizeUsername(username);
      const ext = kind === "video" ? "mp4" : extFromUrl(url) ?? "jpg";
      return `${folder}/media/${safeUser}/${tweetId}_${mediaIndex}.${ext}`;
    }

    /**
     * Per-source plug-in for the run loop. The bookmarks and user-archive
     * flows share the same pagination, audit, pre-flight, and download
     * machinery — they only differ in *which* GraphQL endpoint they hit and
     * which entries they accept.
     */
    interface SourceContext {
      source: SourceKey;
      description: string; // for log lines
      fetchPage(cursor: string | null): Promise<unknown>;
      extractEntries(json: unknown): {
        entries: unknown[];
        nextCursor: string | null;
        /** True when X's cursor signals "stop if you got nothing". */
        stopOnEmptyResponse?: boolean;
        /** Optional per-shape counts for diagnostic logging. */
        raw?: { items: number; modules: number; cursors: number; other: number };
      };
      acceptEntry(entry: unknown): boolean;
    }

    async function createSourceContext(
      source: SourceKey,
      userMode: "media" | "tweets" = "media",
    ): Promise<SourceContext> {
      if (source === "bookmarks") {
        const ep = captured.endpoints.Bookmarks;
        if (!ep) {
          throw new Error(
            "No Bookmarks endpoint captured yet. Open https://x.com/i/bookmarks and scroll once.",
          );
        }
        return {
          source: "bookmarks",
          description: `Bookmarks (queryId=${ep.queryId})`,
          fetchPage: (cursor) =>
            fetchBookmarksPage({
              host: "x.com",
              queryId: ep.queryId,
              operation: "Bookmarks",
              cursor,
              captured,
            }),
          extractEntries,
          acceptEntry: () => true, // user explicitly bookmarked it; trust intent
        };
      }
      if (isUserSource(source)) {
        const handle = sourceUsername(source);
        if (!handle) throw new Error(`Bad user source: ${source}`);
        const userByScreenName = captured.endpoints.UserByScreenName;
        // UserMedia is preferred (faster, only media-bearing tweets); UserTweets
        // is opt-in via userMode for "include text-only originals".
        const opName = userMode === "tweets" ? "UserTweets" : "UserMedia";
        const ep = captured.endpoints[opName];
        if (!userByScreenName || !ep) {
          const missing: string[] = [];
          if (!userByScreenName) missing.push("UserByScreenName");
          if (!ep) missing.push(opName);
          const visitHint =
            opName === "UserMedia"
              ? `https://x.com/${handle}/media`
              : `https://x.com/${handle}`;
          throw new Error(
            `Missing endpoint${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
              `Visit ${visitHint} and scroll once so the extension can capture the request.`,
          );
        }
        appendLog(`Resolving @${handle}…`);
        await persist();
        const user = await fetchUserByScreenName(handle, userByScreenName.queryId, captured);
        appendLog(`@${handle} → user_id ${user.rest_id}`);
        const userId = user.rest_id;
        const fetcher = opName === "UserMedia" ? fetchUserMediaPage : fetchUserTweetsPage;
        return {
          source,
          description: `${opName} for @${handle} (rest_id=${userId}, queryId=${ep.queryId})`,
          fetchPage: (cursor) =>
            fetcher({
              userId,
              queryId: ep.queryId,
              cursor,
              captured,
            }),
          extractEntries: extractUserTweetsEntries,
          // Originals only — even on UserMedia we filter just in case retweeted media slips through.
          acceptEntry: (entry) => !isRetweet(entry),
        };
      }
      throw new Error(`Unknown source: ${source}`);
    }

    async function runSync(options: SyncOptions): Promise<void> {
      const source = options.source;
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
        const ctx = await createSourceContext(source, options.userMode ?? "media");
        appendLog(`Endpoint: ${ctx.description}`);
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
          const reconciled = await auditAgainstChromeDownloads(manifest, options.folder);
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
        // Pages that returned no item-bearing content. UserMedia / UserTweets
        // can hand back cursor-only pages forever after the real content ends;
        // we treat 2 in a row as "X is out of content" and bail.
        let consecutiveEmptyPages = 0;

        while (runtime.pageCount < options.maxPages) {
          if (cancelFlag) break;
          runtime.pageCount++;
          appendLog(`Page ${runtime.pageCount}…`);
          await persist();

          let json: unknown;
          try {
            json = await ctx.fetchPage(cursor);
          } catch (e) {
            const msg = (e as Error).message ?? String(e);
            if (/HTTP 404/.test(msg) && /Query not found/i.test(msg)) {
              appendLog(
                "404 — endpoint queryId rotated. Visit X again (refresh the relevant page) so the new queryId is captured, then retry.",
              );
            }
            throw e;
          }
          const { entries, nextCursor, raw, stopOnEmptyResponse } = ctx.extractEntries(json);
          if (raw) {
            const cursorTag = nextCursor
              ? `next=${nextCursor.slice(0, 30)}…${stopOnEmptyResponse ? " stopOnEmpty" : ""}`
              : "no-cursor";
            appendLog(
              `Page ${runtime.pageCount} raw: ${raw.items} items, ${raw.modules} modules, ${raw.cursors} cursors, ${raw.other} other → ${entries.length} parsable (${cursorTag})`,
            );
            // On empty content pages, log a tiny snippet of the response so we
            // can tell if X is serving a different shape, an error envelope, or
            // genuinely an empty timeline. Capped to keep PII / secrets out.
            if (entries.length === 0) {
              try {
                const sample = JSON.stringify(json).slice(0, 280);
                appendLog(`Page ${runtime.pageCount} response head: ${sample}`);
              } catch {}
            }
          }
          // Bail if X is feeding us cursor-only pages. Two signals trigger this:
          // (a) the cursor explicitly says stopOnEmptyResponse, or
          // (b) we just got our 2nd-in-a-row content-free page (defense in depth).
          if (entries.length === 0) {
            consecutiveEmptyPages++;
            if (stopOnEmptyResponse) {
              appendLog("Cursor signals stopOnEmptyResponse — end of timeline.");
              break;
            }
            if (consecutiveEmptyPages >= 2) {
              appendLog(
                `${consecutiveEmptyPages} consecutive empty pages — assuming end of timeline.`,
              );
              break;
            }
          } else {
            consecutiveEmptyPages = 0;
          }
          let newOnPage = 0;

          for (const entry of entries) {
            if (!ctx.acceptEntry(entry)) continue; // e.g. retweets in user-archive
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
          // Bail when the cursor doesn't move (no more pages) OR we have no
          // cursor at all. Don't bail on empty entries alone — UserMedia and
          // similar endpoints can return cursor-only pages while warming up.
          if (!nextCursor || nextCursor === cursor) break;
          cursor = nextCursor;
          // 1.8–2.6s between user-archive pages — X tends to throttle
          // tighter cadences to empty responses. Bookmarks is more lenient
          // but the same pacing is fine.
          await sleep(1800 + Math.random() * 800);
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
            (p) => {
              if (cancelFlag) return Promise.resolve(false);
              const expected = expectedMediaPath(
                options.folder,
                source,
                p.tweetId,
                p.username,
                p.mediaIndex,
                p.kind,
                p.url,
              );
              return existsAtPath(p.url, expected);
            },
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

        const finishedAtIso = new Date().toISOString();
        manifest.lastRun = {
          finishedAt: finishedAtIso,
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
        await writeSourceDataJs(options.folder, manifest);
        await writeMasterIndex(options.folder);

        // Per-crawl manifest for user-archive sources — the unit of comparison
        // when two users want to diff their archives of the same handle.
        if (isUserSource(source)) {
          await writeCrawlManifest(options.folder, manifest, finishedAtIso, stoppedEarly);
        }

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

      const source: SourceKey = (runtime.options?.source as SourceKey) ?? "bookmarks";
      const folder = runtime.options?.folder ?? "xshelf";
      const manifest = await loadManifest(source);

      try {
        while (pendingMedia.length > 0) {
          if (cancelFlag) break;
          const item = pendingMedia[0];
          // Single shared media tree: xshelf/media/<author>/<id>_<n>.<ext>
          const filename = expectedMediaPath(
            folder,
            source,
            item.tweetId,
            item.username,
            item.mediaIndex,
            item.kind,
            item.url,
          );
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
        // Re-write the snapshot + per-source data + master index now that media
        // `downloaded` flags are flipped.
        await writeSnapshot(folder, manifest);
        await writeSourceDataJs(folder, manifest);
        await writeMasterIndex(folder);

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
    /**
     * Write a per-crawl manifest for a user-archive source. Lives at
     *   <folder>/users/<handle>/crawls/<iso>.json
     * with a sha256 over sorted tweet ids so two archives of the same handle
     * can be compared cheaply (same hash → identical contents; different hash
     * → diff the id sets to find what one has that the other doesn't).
     */
    async function writeCrawlManifest(
      folder: string,
      manifest: Manifest,
      finishedAtIso: string,
      stoppedEarly: boolean,
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
          pages: runtime.pageCount,
          stoppedEarly,
        };
        // Filename-safe ISO (drop colons + decimal seconds → 2026-05-03T12-00-00Z)
        const fnameStamp = finishedAtIso.replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z");
        const json = JSON.stringify(crawl, null, 2);
        const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
        const path = `${folder}/users/${handle}/crawls/${fnameStamp}.json`;
        await downloadFile(dataUrl, path, "overwrite");
        appendLog(`Crawl manifest: ${ids.length} tweets, sha256=${contentHash.slice(0, 12)}…`);
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
    async function writeSourceDataJs(folder: string, manifest: Manifest): Promise<void> {
      try {
        const sourcePath = sourceDiskPath(manifest.source);
        const sortedBookmarks = Object.values(manifest.bookmarks).sort((a, b) => {
          const ta = a.lastSeenAt ? Date.parse(a.lastSeenAt) || 0 : 0;
          const tb = b.lastSeenAt ? Date.parse(b.lastSeenAt) || 0 : 0;
          if (tb !== ta) return tb - ta;
          return (a.lastSeenIndex ?? 1e9) - (b.lastSeenIndex ?? 1e9);
        });
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
        const dataUrl =
          "data:application/javascript;charset=utf-8," + encodeURIComponent(js);
        await downloadFile(dataUrl, `${folder}/${sourcePath}/data.js`, "overwrite");
      } catch (e) {
        appendLog(`data.js write failed: ${(e as Error).message}`);
      }
    }

    /**
     * Master xshelf/index.html: a singlefile Preact bundle from
     * vite.master.config.ts with `<script src>` tags injected for every known
     * source's data.js. Rewritten on every sync so newly-added sources
     * appear automatically.
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
        const html = masterTemplate.replace(
          /<!--\s*xshelf-source-scripts-start\s*-->[\s\S]*?<!--\s*xshelf-source-scripts-end\s*-->/,
          `<!-- xshelf-source-scripts-start -->\n    ${tags}\n    <!-- xshelf-source-scripts-end -->`,
        );
        const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
        await downloadFile(dataUrl, `${folder}/index.html`, "overwrite");
        appendLog(`Master index regenerated (${sources.length} source${sources.length === 1 ? "" : "s"}).`);
      } catch (e) {
        appendLog(`Master index write failed: ${(e as Error).message}`);
      }
    }

    async function writeSnapshot(folder: string, manifest: Manifest): Promise<void> {
      try {
        const sourcePath = sourceDiskPath(manifest.source); // "bookmarks" or "users/<handle>"
        const html = snapshotTemplate;

        // Relative path from this explorer.html's directory back up to the
        // shared `<folder>/media/` tree. Bookmarks lives one level deep
        // (`bookmarks/explorer.html` → `../media/`); user archives live two
        // levels deep (`users/<h>/explorer.html` → `../../media/`).
        const depth = sourcePath.split("/").length;
        const mediaPathPrefix = "../".repeat(depth) + "media/";

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
          source: manifest.source,
          mediaPathPrefix,
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
        //   xshelf/users/elonmusk/explorer.html
        // Phase 2 will add a master xshelf/index.html that aggregates sources.
        await downloadFile(dataUrl, `${folder}/${sourcePath}/explorer.html`, "overwrite");
      } catch (e) {
        appendLog(`Snapshot write failed: ${(e as Error).message}`);
      }
    }

    async function auditAgainstChromeDownloads(
      manifest: Manifest,
      folder: string,
    ): Promise<number> {
      type AuditItem = {
        tweetId: string;
        mediaIndex: number;
        url: string;
        expectedPath: string;
      };
      const pending: AuditItem[] = [];
      for (const id of Object.keys(manifest.bookmarks)) {
        const t = manifest.bookmarks[id];
        for (const m of t.media ?? []) {
          if (!m.downloaded && m.url) {
            pending.push({
              tweetId: id,
              mediaIndex: m.index,
              url: m.url,
              expectedPath: expectedMediaPath(
                folder,
                manifest.source,
                t.id,
                t.username,
                m.index,
                m.kind,
                m.url,
              ),
            });
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
        (p) => (cancelFlag ? Promise.resolve(false) : existsAtPath(p.url, p.expectedPath)),
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
                  hasAuth: !!(captured.auth?.authorization && captured.auth?.csrf),
                  hasBookmarks: !!captured.endpoints.Bookmarks,
                  hasUserByScreenName: !!captured.endpoints.UserByScreenName,
                  hasUserTweets: !!captured.endpoints.UserTweets,
                  hasUserMedia: !!captured.endpoints.UserMedia,
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
              // Source-aware so the popup can wipe just the active source.
              await clearManifest((msg.source as SourceKey | undefined) ?? "bookmarks");
              sendResponse({ ok: true });
              return;
            }
            case "getManifest": {
              const m = await loadManifest((msg.source as SourceKey | undefined) ?? "bookmarks");
              sendResponse({ ok: true, manifest: m });
              return;
            }
            case "listSources": {
              const sources = await listSources();
              sendResponse({ ok: true, sources });
              return;
            }
            case "wipeAll": {
              await wipeAll();
              runtime = freshRuntime();
              pendingMedia = [];
              captured = { auth: null, endpoints: {} };
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
