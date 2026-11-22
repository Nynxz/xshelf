import { defineBackground } from "wxt/sandbox";
import { SW_VERSION } from "../lib/messaging";
import { createArchiveWriter } from "../lib/archive-export";
import type {
  Bookmark,
  Captured,
  Manifest,
  Media,
  PendingMediaItem,
  PendingSummary,
  MediaVariant,
  RuntimeState,
  SourceKey,
  SyncOptions,
  UnbookmarkOptions,
  UnbookmarkPreviewEntry,
  UnbookmarkReport,
  VerifyReport,
} from "../lib/types";
import {
  CAPTURED_OP_NAMES,
  DEFAULT_MEDIA_VARIANT,
  KNOWN_MEDIA_VARIANTS,
  isMediaTimelineCandidate,
  isUserSource,
  looksLikeMediaTimelineOp,
  mediaVariantFromFilter,
  mediaVariantLabel,
  mediaVariantPath,
  sortMediaVariants,
  sourceUsername,
} from "../lib/types";
import {
  addCleanupTombstones,
  clearCleanupTombstones,
  clearManifest,
  clearPending,
  freshRuntime,
  listSources,
  loadCaptured,
  loadCleanupTombstones,
  loadManifest,
  loadPending,
  loadRuntime,
  migrateLegacyManifest,
  saveCaptured,
  saveManifest,
  savePending,
  saveRuntime,
  wipeAll,
  saveVerifyReport,
  clearVerifyReport,
} from "../lib/storage";
import {
  allMediaDownloaded,
  createBookmark,
  deleteBookmark,
  extFromUrl,
  extractEntries,
  fetchBookmarksPage,
  parseTweetEntry,
  sanitizeUsername,
} from "../lib/bookmarks";
import {
  cancelAllDownloads,
  downloadFile,
  buildDownloadIndex,
  downloadsElsewhere,
  probeDownloadRoot,
} from "../lib/downloads";
import {
  extractUserTweetsEntries,
  fetchUserByScreenName,
  fetchUserMediaPage,
  fetchUserTweetsPage,
  isRetweet,
} from "../lib/users";

/**
 * Hard ceiling on pages for a full scan. The per-sync page cap is tuned for
 * quick incremental runs and would truncate a full scan long before the end of
 * a large timeline; this ceiling exists only so a pathological cursor chain
 * can't paginate forever.
 */
const FULL_SCAN_MAX_PAGES = 2000;

/** Pages a single pass may fetch, honouring the full-scan override. */
function pageBudgetFor(options: SyncOptions): number {
  return options.fullScan
    ? Math.max(options.maxPages, FULL_SCAN_MAX_PAGES)
    : options.maxPages;
}

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

    const {
      writeSource,
      writeSourceDataJs,
      writeMasterIndex,
      writeCrawlManifest,
      backupManifestToDisk,
    } = createArchiveWriter(appendLog);

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
          appendLog(
            `Migrated ${result.count} legacy bookmarks to v2 multi-source layout.`,
          );
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
      } else if (runtime.status === "verifying") {
        // Verify makes no on-disk changes; safe to drop back to idle on restart.
        runtime.status = pendingMedia.length > 0 ? "ready" : "idle";
        runtime.currentPhase = null;
        appendLog("Verify pass interrupted by service worker restart.");
        await persistNow();
      } else if (runtime.status === "unbookmarking") {
        runtime.status = "interrupted";
        runtime.errorMessage =
          "Service worker was restarted mid-unbookmark. Some deletes may have completed — re-sync from x.com/i/history to see your current state.";
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

    // === CAPTURE (request bodies for DeleteBookmark + CreateBookmark) ===
    // Hook into onBeforeRequest so we can read the JSON body the X web client
    // sends when the user manually adds/removes a bookmark. Storing them as
    // templates lets us mirror X's exact request shape (including any features
    // / folder fields they've added) instead of guessing at it.
    function captureBookmarkMutationBody(
      details: chrome.webRequest.WebRequestBodyDetails,
      bodyField: "deleteBookmarkBody" | "createBookmarkBody",
      urlField: "deleteBookmarkUrl" | "createBookmarkUrl",
      label: string,
    ): void {
      if (details.method !== "POST") return;
      // Skip our own replay requests: if we already have a template AND the
      // URL is the one we're hitting right now (extension-initiated), don't
      // re-capture from our own traffic. Recognise by initiator — Chrome sets
      // initiator to the extension URL for fetches from the SW.
      if (
        details.initiator &&
        details.initiator.startsWith("chrome-extension://")
      ) {
        return;
      }
      const raw = details.requestBody?.raw?.[0]?.bytes;
      if (!raw) return;
      try {
        const text = new TextDecoder().decode(raw);
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          captured[bodyField] = parsed as Record<string, unknown>;
          captured[urlField] = details.url;
          saveCaptured(captured);
          appendLog(`Captured ${label} request: ${details.url}`);
        }
      } catch {
        // Body isn't JSON or has a shape we don't recognize — leave alone.
      }
    }
    chrome.webRequest.onBeforeRequest.addListener(
      (d) =>
        captureBookmarkMutationBody(
          d,
          "deleteBookmarkBody",
          "deleteBookmarkUrl",
          "DeleteBookmark",
        ),
      {
        urls: [
          "https://x.com/i/api/graphql/*/DeleteBookmark*",
          "https://twitter.com/i/api/graphql/*/DeleteBookmark*",
        ],
      },
      ["requestBody"],
    );
    chrome.webRequest.onBeforeRequest.addListener(
      (d) =>
        captureBookmarkMutationBody(
          d,
          "createBookmarkBody",
          "createBookmarkUrl",
          "CreateBookmark",
        ),
      {
        urls: [
          "https://x.com/i/api/graphql/*/CreateBookmark*",
          "https://twitter.com/i/api/graphql/*/CreateBookmark*",
        ],
      },
      ["requestBody"],
    );

    // === CAPTURE (auth + endpoint via webRequest) ===
    // Headers that `fetch()` either silently drops or rejects when set in a
    // request init dict — don't bother capturing/replaying these.
    const RESTRICTED_HEADERS = new Set([
      "accept-charset",
      "accept-encoding",
      "access-control-request-headers",
      "access-control-request-method",
      "connection",
      "content-length",
      "cookie",
      "cookie2",
      "date",
      "dnt",
      "expect",
      "host",
      "keep-alive",
      "origin",
      "permissions-policy",
      "proxy-authenticate",
      "proxy-authorization",
      "referer",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "user-agent",
      "via",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-dest",
      "sec-fetch-user",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
    ]);
    /** Parse a JSON-encoded query parameter (variables / features / fieldToggles). */
    function parseJsonParam(
      url: URL,
      name: string,
    ): Record<string, unknown> | undefined {
      const raw = url.searchParams.get(name);
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Which media sub-view an x.com page URL represents, or null when the URL
     * isn't a profile Media tab at all (so callers can tell "not a media page"
     * apart from "the unfiltered media page").
     */
    function mediaVariantFromPageUrl(
      pageUrl: string | undefined,
    ): MediaVariant | null {
      if (!pageUrl) return null;
      try {
        const u = new URL(pageUrl);
        if (!/^(x|twitter)\.com$/i.test(u.hostname)) return null;
        const segs = u.pathname.split("/").filter(Boolean);
        if (segs.length < 2 || segs[1] !== "media") return null;
        return mediaVariantFromFilter(u.searchParams.get("filter"));
      } catch {
        return null;
      }
    }

    /**
     * Store a real media-timeline request keyed by the media sub-view that
     * issued it. Replaying the captured `variables` verbatim is what lets us
     * crawl a filtered view without knowing which flag X filters it with;
     * replaying the captured *operation* is what lets us survive X splitting
     * `UserMedia` into per-view operations (`UserPhotoTimeline` & co.).
     */
    async function rememberMediaViewRequest(
      details: chrome.webRequest.WebRequestHeadersDetails,
      url: URL,
      queryId: string,
      operation: string,
      variables: Record<string, unknown>,
    ): Promise<void> {
      // `documentUrl` reflects the SPA's current (pushState) URL; fall back to
      // the tab when it's missing. Host permissions cover reading x.com tabs.
      let pageUrl = (details as { documentUrl?: string }).documentUrl;
      let variant = mediaVariantFromPageUrl(pageUrl);
      if (variant === null && details.tabId >= 0) {
        try {
          const tab = await chrome.tabs.get(details.tabId);
          if (tab?.url) {
            pageUrl = tab.url;
            variant = mediaVariantFromPageUrl(pageUrl);
          }
        } catch {
          // tab gone, or no permission for its URL — fall through
        }
      }
      const key: MediaVariant = variant ?? DEFAULT_MEDIA_VARIANT;
      if (variant === null) {
        // Couldn't tie the request to a Media tab (prefetch, hover card, or a
        // page URL we failed to read). Structural detection isn't trustworthy
        // without that attribution, so fall back to the operation name — and
        // even then only far enough to bootstrap. Letting an unattributable
        // request overwrite a confirmed capture is how the default view would
        // silently end up holding the photo view's request.
        if (!looksLikeMediaTimelineOp(operation)) return;
        if (captured.userMedia?.[key]) return;
      }

      // Drop the browser's mid-scroll cursor — our crawl always starts at the
      // top of the timeline and supplies its own.
      const cleanVariables = { ...variables };
      delete cleanVariables.cursor;

      const request = {
        queryId,
        operation,
        variables: cleanVariables,
        features: parseJsonParam(url, "features"),
        fieldToggles: parseJsonParam(url, "fieldToggles"),
      };
      // Scrolling a media view fires this listener once per page; rewriting
      // storage each time buys nothing. `capturedAt` therefore marks when this
      // request *shape* was first seen, which is the staleness signal we
      // actually want to show the user.
      const prev = captured.userMedia?.[key];
      const same =
        prev &&
        JSON.stringify({
          queryId: prev.queryId,
          operation: prev.operation,
          variables: prev.variables,
          features: prev.features,
          fieldToggles: prev.fieldToggles,
        }) === JSON.stringify(request);
      if (same && captured.mediaOps?.[operation]?.queryId === queryId) return;

      captured.userMedia = {
        ...(captured.userMedia ?? {}),
        [key]: {
          ...request,
          capturedAt: same && prev ? prev.capturedAt : new Date().toISOString(),
          pageUrl,
        },
      };
      // Freshest queryId per operation name, independent of which view issued
      // it: queryIds rotate every X release, and a view the user hasn't
      // revisited since would otherwise replay a dead one and 404.
      captured.mediaOps = {
        ...(captured.mediaOps ?? {}),
        [operation]: { queryId, seenAt: new Date().toISOString() },
      };
      await saveCaptured(captured);
    }

    chrome.webRequest.onSendHeaders.addListener(
      (details) => {
        // Skip our own replay requests (initiator is the extension itself).
        if (
          details.initiator &&
          details.initiator.startsWith("chrome-extension://")
        ) {
          return;
        }
        let touched = false;
        const auth = { ...(captured.auth ?? {}) } as {
          authorization?: string;
          csrf?: string;
        };
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
          captured.auth = {
            authorization: auth.authorization,
            csrf: auth.csrf,
          };
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
          // X's profile Media tab is filtered (/media vs /media?filter=photo)
          // and each view drives its own request — under its own operation
          // name, since X split `UserMedia` into `UserPhotoTimeline` & co. So
          // neither a name nor a single queryId identifies a view any more:
          // record the whole request per view and replay it. Detection is
          // deliberately structural (a paginated by-userId query issued from a
          // Media tab) so the next rename needs no code change.
          let gqlUrl: URL | null = null;
          try {
            gqlUrl = new URL(details.url);
          } catch {
            gqlUrl = null;
          }
          const gqlVariables = gqlUrl
            ? parseJsonParam(gqlUrl, "variables")
            : undefined;
          if (gqlUrl && gqlVariables && isMediaTimelineCandidate(op, gqlVariables)) {
            rememberMediaViewRequest(
              details,
              gqlUrl,
              queryId,
              op,
              gqlVariables,
            ).catch(() => {});
          }
        }
        // For the two bookmark MUTATIONS, capture the full header set (sans
        // restricted ones). X is stricter on writes than reads — it expects
        // anti-abuse headers like x-client-uuid / x-client-transaction-id
        // computed by the JS client. Without them, CreateBookmark returns 404
        // (we observed this; DeleteBookmark is lenient and just returns 144).
        const isMutation =
          details.url.includes("/DeleteBookmark") ||
          details.url.includes("/CreateBookmark");
        if (isMutation && details.requestHeaders) {
          const hdrs: Record<string, string> = {};
          for (const h of details.requestHeaders) {
            const name = h.name.toLowerCase();
            if (!RESTRICTED_HEADERS.has(name) && typeof h.value === "string") {
              hdrs[name] = h.value;
            }
          }
          if (details.url.includes("/DeleteBookmark")) {
            captured.deleteBookmarkHeaders = hdrs;
          } else {
            captured.createBookmarkHeaders = hdrs;
          }
          touched = true;
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
      const ext = kind === "video" ? "mp4" : (extFromUrl(url) ?? "jpg");
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
      /** Short name for this pass, e.g. "photos". Only meaningful multi-pass. */
      label: string;
      description: string; // for log lines
      /**
       * What to tell the user when this pass fails in a way a fresh capture
       * would fix. Each media view is captured from its own page, so "refresh
       * the relevant page" isn't actionable without naming which one.
       */
      recaptureHint?: string;
      fetchPage(cursor: string | null): Promise<unknown>;
      extractEntries(json: unknown): {
        entries: unknown[];
        nextCursor: string | null;
        /** True when X's cursor signals "stop if you got nothing". */
        stopOnEmptyResponse?: boolean;
        /** Optional per-shape counts for diagnostic logging. */
        raw?: {
          items: number;
          modules: number;
          cursors: number;
          other: number;
          itemTypes?: Record<string, number>;
          deepScan?: boolean;
        };
      };
      acceptEntry(entry: unknown): boolean;
    }

    /**
     * Build the crawl passes for a source. Everything except a user's media
     * archive is a single pass; media is one pass per captured sub-view of X's
     * filtered Media tab, all merging into the same manifest.
     */
    async function createSourceContexts(
      source: SourceKey,
      userMode: "media" | "tweets" = "media",
    ): Promise<SourceContext[]> {
      if (source === "bookmarks") {
        const ep = captured.endpoints.Bookmarks;
        if (!ep) {
          throw new Error(
            "No Bookmarks endpoint captured yet. Open https://x.com/i/history and scroll once.",
          );
        }
        return [{
          source: "bookmarks",
          label: "bookmarks",
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
        }];
      }
      if (isUserSource(source)) {
        const handle = sourceUsername(source);
        if (!handle) throw new Error(`Bad user source: ${source}`);
        const userByScreenName = captured.endpoints.UserByScreenName;
        // UserMedia is preferred (faster, only media-bearing tweets); UserTweets
        // is opt-in via userMode for "include text-only originals".
        const opName = userMode === "tweets" ? "UserTweets" : "UserMedia";
        const ep = captured.endpoints[opName];
        // Media mode can also run purely off captured per-variant requests, so
        // a missing legacy UserMedia queryId isn't fatal there.
        const mediaStore = captured.userMedia ?? {};
        const capturedVariants = sortMediaVariants(Object.keys(mediaStore));
        const haveMediaRequest =
          opName === "UserTweets" ? !!ep : !!ep || capturedVariants.length > 0;
        if (!userByScreenName || !haveMediaRequest) {
          const missing: string[] = [];
          if (!userByScreenName) missing.push("UserByScreenName");
          // The media grid has no fixed operation name to report any more —
          // X serves each view under its own (UserPhotoTimeline & co.) — so
          // name the page to visit instead of an endpoint that may not exist.
          if (!haveMediaRequest) {
            missing.push(
              opName === "UserTweets" ? "UserTweets" : "a Media tab request",
            );
          }
          const visitHint =
            opName === "UserTweets"
              ? `https://x.com/${handle}`
              : `https://x.com${mediaVariantPath(handle, DEFAULT_MEDIA_VARIANT)}`;
          throw new Error(
            `Missing endpoint${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
              `Visit ${visitHint} and scroll once so the extension can capture the request.`,
          );
        }
        appendLog(`Resolving @${handle}…`);
        await persist();
        const user = await fetchUserByScreenName(
          handle,
          userByScreenName.queryId,
          captured,
        );
        appendLog(`@${handle} → user_id ${user.rest_id}`);
        const userId = user.rest_id;

        if (opName === "UserTweets") {
          return [{
            source,
            label: "posts",
            description: `UserTweets for @${handle} (rest_id=${userId}, queryId=${ep!.queryId})`,
            recaptureHint: `Scroll https://x.com/${handle} once so the new queryId is captured`,
            fetchPage: (cursor) =>
              fetchUserTweetsPage({
                userId,
                queryId: ep!.queryId,
                cursor,
                captured,
              }),
            extractEntries: extractUserTweetsEntries,
            acceptEntry: (entry) => !isRetweet(entry),
          }];
        }

        // ---- Media: one pass per captured sub-view of X's filtered Media tab.
        if (capturedVariants.length === 0) {
          // Nothing captured per-variant (upgrade from an older build, or the
          // user never opened a Media tab under this version). Fall back to the
          // legacy single pass with our hardcoded variables. `ep` is guaranteed
          // here — haveMediaRequest above required one or the other.
          appendLog(
            `No per-view media request captured — falling back to a single ` +
              `unfiltered UserMedia pass with hardcoded variables, which X may ` +
              `reject outright now that the Media tab moved to per-view ` +
              `operations. Visit ${KNOWN_MEDIA_VARIANTS.map((v) => mediaVariantPath(handle, v)).join(" and ")} ` +
              `and scroll each once to archive every view properly.`,
          );
          return [{
            source,
            label: "media",
            description: `UserMedia for @${handle} (rest_id=${userId}, queryId=${ep!.queryId}, legacy)`,
            recaptureHint:
              `Scroll https://x.com${mediaVariantPath(handle, DEFAULT_MEDIA_VARIANT)} ` +
              `once so the extension captures the request that view actually makes`,
            fetchPage: (cursor) =>
              fetchUserMediaPage({
                userId,
                queryId: ep!.queryId,
                cursor,
                captured,
              }),
            extractEntries: extractUserTweetsEntries,
            acceptEntry: (entry) => !isRetweet(entry),
          }];
        }

        // Two views whose captured requests are byte-identical are the same
        // timeline — X either ignores that filter or we mis-attributed the
        // capture. Crawling both would just double the request count.
        const bySignature = new Map<string, MediaVariant>();
        for (const v of capturedVariants) {
          const tpl = mediaStore[v]!;
          const sig = `${tpl.operation}|${tpl.queryId}|${JSON.stringify(tpl.variables)}`;
          const first = bySignature.get(sig);
          if (first) {
            appendLog(
              `Skipping ${mediaVariantLabel(v)} view — same request as the ${mediaVariantLabel(first)} view.`,
            );
            continue;
          }
          bySignature.set(sig, v);
        }
        const variants = sortMediaVariants([...bySignature.values()]);
        const uncaptured = KNOWN_MEDIA_VARIANTS.filter((v) => !mediaStore[v]);
        if (uncaptured.length > 0) {
          appendLog(
            `Not captured yet: ${uncaptured.map((v) => mediaVariantLabel(v)).join(", ")}. ` +
              `Visit ${uncaptured.map((v) => mediaVariantPath(handle, v)).join(" and ")} and scroll once to include them.`,
          );
        }

        return variants.map((v) => {
          const tpl = mediaStore[v]!;
          // queryIds rotate with X releases and are per-*operation*, so the
          // most recently seen queryId for THIS template's operation beats the
          // one frozen into an older capture — which matters when two views
          // share an operation and the user only revisited one of them. The
          // captured `variables` — the part we can't guess — is what we
          // actually need from the template.
          const queryId =
            captured.mediaOps?.[tpl.operation]?.queryId ??
            (tpl.operation === "UserMedia" && ep ? ep.queryId : tpl.queryId);
          const rotated = queryId !== tpl.queryId;
          return {
            source,
            label: mediaVariantLabel(v),
            description:
              `${tpl.operation}[${v}] for @${handle} (rest_id=${userId}, ` +
              `queryId=${queryId}${rotated ? " refreshed" : ""}, ` +
              `captured ${tpl.capturedAt.slice(0, 16).replace("T", " ")})`,
            // X renames these operations, not just their queryIds — so the fix
            // for a dead capture is re-scrolling THIS view, which reveals both.
            recaptureHint:
              `Scroll https://x.com${mediaVariantPath(handle, v)} once to ` +
              `re-capture the ${mediaVariantLabel(v)} request`,
            fetchPage: (cursor) =>
              fetchUserMediaPage({
                userId,
                queryId,
                cursor,
                captured,
                template: { ...tpl, queryId },
              }),
            extractEntries: extractUserTweetsEntries,
            // Originals only — even on a media timeline we filter, just in
            // case retweeted media slips through.
            acceptEntry: (entry) => !isRetweet(entry),
          };
        });
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
      const pageBudget = pageBudgetFor(options);
      appendLog(
        `Sync → ${options.folder}/  (maxPages=${pageBudget}${
          options.fullScan ? " full-scan" : ""
        }, incremental=${options.incremental})`,
      );
      await persist();

      try {
        if (!captured.auth?.authorization || !captured.auth?.csrf) {
          throw new Error(
            "No auth captured yet. Open https://x.com/i/history (or refresh it) so the extension can observe the request.",
          );
        }
        const downloadRoot = await probeDownloadRoot(options.folder);
        appendLog(`Download directory: ${downloadRoot}`);
        const contexts = await createSourceContexts(
          source,
          options.userMode ?? "media",
        );
        if (contexts.length > 1) {
          appendLog(
            `${contexts.length} passes: ${contexts.map((c) => c.label).join(", ")} ` +
              `(up to ${pageBudget} pages each, merged into one archive).`,
          );
        }
        for (const c of contexts) appendLog(`Endpoint: ${c.description}`);
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
          const reconciled = await auditAgainstChromeDownloads(
            manifest,
            options.folder,
            downloadRoot,
          );
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
        //
        // One pass per source context. A user's media archive is spread over
        // X's filtered Media views (/media, /media?filter=photo, …), each with
        // its own timeline and cursor chain, so we crawl them in sequence and
        // merge into a single manifest — `queuedKey` and `syncEncounterIndex`
        // are run-global precisely so a tweet that shows up in two views is
        // only counted, ordered and queued once.
        runtime.currentPhase = "fetch";
        await persist();
        const queuedKey = new Set<string>();
        const earlyStopAfter = options.earlyStopAfter ?? 30;
        const fullScan = !!options.fullScan;
        let syncEncounterIndex = 0;
        let stoppedEarly = false;
        // Set when a pass exits on the page budget with a live cursor still in
        // hand — the timeline had more to give and we chose not to ask.
        let hitPageCap = false;
        if (fullScan) {
          appendLog(
            `Full scan: paginating to the end of each view (no early stop, up to ${pageBudget} pages). ` +
              `Already-downloaded items are still skipped.`,
          );
        }

        let passIndex = 0;
        // A view whose captured request X now rejects shouldn't throw away the
        // views that did work — collect per-pass failures and only fail the run
        // if every pass failed.
        const passErrors: Array<{ label: string; error: string }> = [];
        for (const ctx of contexts) {
          if (cancelFlag) break;
          const tag = contexts.length > 1 ? `[${ctx.label}] ` : "";
          if (contexts.length > 1) {
            appendLog(
              `--- Pass ${passIndex + 1}/${contexts.length}: ${ctx.label} ---`,
            );
            await persist();
            // Same pacing between passes as between pages — the pass boundary
            // is just another request to X as far as its throttling cares.
            if (passIndex > 0) await sleep(1800 + Math.random() * 800);
          }
          passIndex++;
          // Per-pass state: each view is its own cursor chain, so early-stop
          // and empty-page counters must not leak between passes.
          let cursor: string | null = null;
          let passPages = 0;
          let consecutiveKnown = 0;
          let passStoppedEarly = false;
          // Pages that returned no item-bearing content. UserMedia / UserTweets
          // can hand back cursor-only pages forever after the real content ends;
          // we treat 2 in a row as "X is out of content" and bail.
          let consecutiveEmptyPages = 0;

          while (passPages < pageBudget) {
            if (cancelFlag) break;
            passPages++;
            runtime.pageCount++;
            appendLog(`${tag}Page ${runtime.pageCount}…`);
            await persist();

            let json: unknown;
            try {
              json = await ctx.fetchPage(cursor);
            } catch (e) {
              const msg = (e as Error).message ?? String(e);
              if (/HTTP 404/.test(msg) && /Query not found/i.test(msg)) {
                appendLog(
                  `404 — endpoint queryId rotated. ${
                    ctx.recaptureHint ??
                    "Visit X again (refresh the relevant page) so the new queryId is captured"
                  }, then retry.`,
                );
              }
              if (contexts.length === 1) throw e;
              // Multi-pass: abandon this view and try the next one.
              appendLog(`${tag}Pass failed: ${msg}`);
              passErrors.push({ label: ctx.label, error: msg });
              await persist();
              break;
            }
            const { entries, nextCursor, raw, stopOnEmptyResponse } =
              ctx.extractEntries(json);
            if (raw) {
              const cursorTag = nextCursor
                ? `next=${nextCursor.slice(0, 30)}…${stopOnEmptyResponse ? " stopOnEmpty" : ""}`
                : "no-cursor";
              // Item types make a reshaped timeline legible: a page of items
              // we can't parse looks identical to an empty page otherwise.
              const typeEntries = Object.entries(raw.itemTypes ?? {});
              const typeTag =
                typeEntries.length > 0
                  ? ` [${typeEntries.map(([t, n]) => `${t}×${n}`).join(", ")}]`
                  : "";
              appendLog(
                `${tag}Page ${runtime.pageCount} raw: ${raw.items} items, ${raw.modules} modules, ${raw.cursors} cursors, ${raw.other} other → ${entries.length} parsable (${cursorTag})${typeTag}${raw.deepScan ? " via deep-scan" : ""}`,
              );
              // On empty content pages, log a tiny snippet of the response so we
              // can tell if X is serving a different shape, an error envelope, or
              // genuinely an empty timeline. Capped to keep PII / secrets out.
              if (entries.length === 0) {
                try {
                  const sample = JSON.stringify(json).slice(0, 280);
                  appendLog(`${tag}Page ${runtime.pageCount} response head: ${sample}`);
                } catch {}
              }
            }
            // Bail if X is feeding us cursor-only pages. Two signals trigger this:
            // (a) the cursor explicitly says stopOnEmptyResponse, or
            // (b) we just got our 2nd-in-a-row content-free page (defense in depth).
            if (entries.length === 0) {
              consecutiveEmptyPages++;
              if (stopOnEmptyResponse) {
                appendLog(
                  "Cursor signals stopOnEmptyResponse — end of timeline.",
                );
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
              const existing = manifest.bookmarks[tweet.id] as
                | Bookmark
                | undefined;
              const nowIso = syncStartedIso;

              if (
                existing &&
                options.incremental &&
                allMediaDownloaded(existing)
              ) {
                syncEncounterIndex++;
                // DON'T re-stamp lastSeenAt/lastSeenIndex on known items. Doing
                // so makes the explorer's "newest bookmarked" sort treat the
                // most recent sync run as if every bookmark were just added,
                // shoving year-old bookmarks to the top of the feed every time
                // the user runs sync. We only refresh engagement stats here.
                existing.replyCount = tweet.replyCount;
                existing.retweetCount = tweet.retweetCount;
                existing.favoriteCount = tweet.favoriteCount;
                existing.quoteCount = tweet.quoteCount;
                // If the user unbookmarked then re-bookmarked this item, X is
                // returning it now → the prior unbookmarkedAt stamp is stale.
                // Clear it so cleanup's "already handled" filter doesn't keep
                // blocking the user from removing it again.
                if (existing.unbookmarkedAt) {
                  delete existing.unbookmarkedAt;
                }
                consecutiveKnown++;
                // The consecutive-known heuristic assumes known items cluster at
                // the top of the timeline. That holds for bookmarks, but not for
                // a user archive whose known items are interleaved with unseen
                // ones — hence the full-scan escape hatch.
                if (!fullScan && consecutiveKnown >= earlyStopAfter) {
                  passStoppedEarly = true;
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
                    ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
                  };
                });
                syncEncounterIndex++;
                // For NEW items, set lastSeenAt to this sync's timestamp so they
                // sort to the top. For EXISTING-but-partial-download items
                // (rare: media wasn't all downloaded yet), preserve the original
                // timestamps so re-syncing-to-finish-downloads doesn't shift
                // them in the explorer either.
                const merged: Bookmark = {
                  ...tweet,
                  media: mergedMedia,
                  firstSeenAt: existing ? existing.firstSeenAt : nowIso,
                  lastSeenAt: existing ? existing.lastSeenAt : nowIso,
                  lastSeenIndex: existing
                    ? (existing.lastSeenIndex ?? syncEncounterIndex)
                    : syncEncounterIndex,
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
              `${tag}Page ${runtime.pageCount}: seen=${runtime.totalSeen}, new=${runtime.newCount}, +${newOnPage} this page, pending=${pendingMedia.length}.`,
            );
            recomputeSummary();
            await persist();
            await saveManifest(manifest);

            if (passStoppedEarly) break;
            // Bail when the cursor doesn't move (no more pages) OR we have no
            // cursor at all. Don't bail on empty entries alone — UserMedia and
            // similar endpoints can return cursor-only pages while warming up.
            if (!nextCursor || nextCursor === cursor) break;
            if (passPages >= pageBudget) {
              hitPageCap = true;
              appendLog(
                `${tag}Page cap (${pageBudget}) reached with pages still available — ` +
                  `this view is only partly crawled.`,
              );
              break;
            }
            cursor = nextCursor;
            // 1.8–2.6s between user-archive pages — X tends to throttle
            // tighter cadences to empty responses. Bookmarks is more lenient
            // but the same pacing is fine.
            await sleep(1800 + Math.random() * 800);
          }
          if (passStoppedEarly) stoppedEarly = true;
        }
        if (passErrors.length > 0) {
          if (passErrors.length === contexts.length) {
            throw new Error(
              `Every media view failed. First error: ${passErrors[0].error}`,
            );
          }
          appendLog(
            `${passErrors.length} of ${contexts.length} passes failed (${passErrors
              .map((p) => p.label)
              .join(", ")}) — the archive is missing those views.`,
          );
        }

        // ---- Pre-flight: drop pending entries already in Chrome's download history
        if (options.incremental && pendingMedia.length) {
          runtime.currentPhase = "preflight";
          appendLog(
            `Pre-flight: checking ${pendingMedia.length} URLs against download history…`,
          );
          await persist();
          const index = await buildDownloadIndex(downloadRoot, options.folder);
          const results = pendingMedia.map((p) =>
            index.hasUrlAt(
              p.url,
              expectedMediaPath(
                options.folder,
                source,
                p.tweetId,
                p.username,
                p.mediaIndex,
                p.kind,
                p.url,
              ),
            ),
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

        // Every way a crawl can end short of "read the timeline to its end".
        // The crawl manifest is meant to be the unit of comparison between two
        // archives of the same handle, so a truncated run must never be recorded
        // as a complete one — least of all a full scan that quietly ran out of
        // page budget.
        const incomplete =
          stoppedEarly || hitPageCap || cancelFlag || passErrors.length > 0;
        if (fullScan && !incomplete) {
          appendLog("Full scan complete: reached the end of every view.");
        }

        const finishedAtIso = new Date().toISOString();
        manifest.lastRun = {
          finishedAt: finishedAtIso,
          pages: runtime.pageCount,
          seen: runtime.totalSeen,
          newCount: runtime.newCount,
          stoppedEarly: incomplete,
          phase: "sync",
        };
        await saveManifest(manifest);

        // Write the on-disk snapshot so the user has an offline-viewable HTML
        // alongside their media files. Done after sync (even before the user
        // accepts the download phase) so the index reflects current manifest state.
        await writeSource(options.folder, manifest);
        await writeMasterIndex(options.folder);

        // Per-crawl manifest for user-archive sources — the unit of comparison
        // when two users want to diff their archives of the same handle.
        if (isUserSource(source)) {
          await writeCrawlManifest(
            options.folder,
            manifest,
            finishedAtIso,
            runtime.pageCount,
            incomplete,
          );
        }

        runtime.totalKnown = Object.keys(manifest.bookmarks).length;
        runtime.finishedAt = new Date().toISOString();
        runtime.currentPhase = null;

        if (cancelFlag) {
          runtime.status = "cancelled";
          appendLog(
            `Cancelled during sync. ${pendingMedia.length} items in pending list.`,
          );
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

      const source: SourceKey =
        (runtime.options?.source as SourceKey) ?? "bookmarks";
      const folder = runtime.options?.folder ?? "xshelf";
      const manifest = await loadManifest(source);
      // Items from a cross-source missing list carry their own sources.
      const manifests = new Map<SourceKey, Manifest>([[source, manifest]]);
      const manifestFor = async (k: SourceKey) => {
        let m = manifests.get(k);
        if (!m) {
          m = await loadManifest(k);
          manifests.set(k, m);
        }
        return m;
      };
      const saveAll = async () => {
        for (const m of manifests.values()) await saveManifest(m);
      };

      // Fail fast if the download directory isn't writable (e.g. a symlink to
      // an unmounted drive) instead of erroring every item one by one. Stays
      // "ready" so the pending list survives for a retry once it's fixed.
      try {
        const root = await probeDownloadRoot(folder);
        appendLog(`Download directory: ${root}`);
        runtime.errorMessage = null;
      } catch (e) {
        runtime.status = "ready";
        runtime.currentPhase = null;
        runtime.errorMessage = (e as Error).message ?? String(e);
        appendLog(`Error: ${runtime.errorMessage}`);
        await persistNow();
        return;
      }

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
            for (const k of item.sources?.length ? item.sources : [source]) {
              const t = (await manifestFor(k)).bookmarks[item.tweetId];
              const m = t?.media?.find((mm) => mm.index === item.mediaIndex);
              if (m) m.downloaded = true;
            }
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
            await saveAll();
          }
        }
        recomputeSummary();
        await savePending(pendingMedia);
        await saveAll();
        // Re-write the snapshot + per-source data + master index now that media
        // `downloaded` flags are flipped.
        for (const m of manifests.values()) {
          await writeSource(folder, m);
        }
        await writeMasterIndex(folder);

        runtime.totalKnown = Object.keys(manifest.bookmarks).length;
        runtime.finishedAt = new Date().toISOString();
        runtime.currentPhase = null;
        if (cancelFlag) {
          runtime.status = pendingMedia.length ? "ready" : "cancelled";
          appendLog(
            `Cancelled during download. ${pendingMedia.length} still pending.`,
          );
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
     * Verify pass: for a single source, cross-check every media item in the
     * manifest against Chrome's download history (NOT the filesystem — extensions
     * can't `stat` files directly). Reports items that *should* be on disk but
     * Chrome says aren't, optionally flipping the `downloaded` flag and pushing
     * them onto the pending queue so the user can re-download with the existing
     * Download flow.
     *
     * `dryRun: true` is the default UX — never modifies state. The user reviews
     * the report and explicitly opts into the repair pass (`dryRun: false`).
     *
     * Concurrency safety: refuses to run while a sync/download is active. Once
     * started, sets status to "verifying" and locks out concurrent runs.
     */
    async function runVerify(
      source: SourceKey,
      folder: string,
      dryRun: boolean,
    ): Promise<VerifyReport> {
      if (
        runtime.status === "syncing" ||
        runtime.status === "downloading" ||
        runtime.status === "cancelling" ||
        runtime.status === "verifying"
      ) {
        throw new Error(`Cannot verify from status "${runtime.status}".`);
      }
      // Refuse to clobber an existing pending list — the user should download
      // or discard before verifying, otherwise pendingMedia mixes sources and
      // runDownload would only update one manifest.
      if (!dryRun && pendingMedia.length > 0) {
        throw new Error(
          `${pendingMedia.length} items already pending — download or discard them before verifying.`,
        );
      }

      const prevStatus = runtime.status;
      runtime.status = "verifying";
      runtime.currentPhase = dryRun ? "verify (dry run)" : "verify";
      runtime.errorMessage = null;
      appendLog(
        `Verify ${source} (${dryRun ? "dry run" : "repair"}) → folder=${folder}`,
      );
      await persist();

      try {
        const downloadRoot = await probeDownloadRoot(folder);
        appendLog(`Download directory: ${downloadRoot}`);
        const manifest = await loadManifest(source);
        type Check = {
          tweetId: string;
          username: string;
          mediaIndex: number;
          kind: PendingMediaItem["kind"];
          url: string;
          expectedPath: string;
          claimedDownloaded: boolean;
        };
        const checks: Check[] = [];
        for (const id of Object.keys(manifest.bookmarks)) {
          const t = manifest.bookmarks[id];
          for (const m of t.media ?? []) {
            if (!m.url) continue;
            checks.push({
              tweetId: id,
              username: t.username,
              mediaIndex: m.index,
              kind: m.kind,
              url: m.url,
              expectedPath: expectedMediaPath(
                folder,
                source,
                t.id,
                t.username,
                m.index,
                m.kind,
                m.url,
              ),
              claimedDownloaded: m.downloaded,
            });
          }
        }

        appendLog(`Verify: ${checks.length} media items to check.`);
        await persist();

        const index = await buildDownloadIndex(downloadRoot, folder);
        appendLog(`Verify: ${index.size} completed downloads in history under ${folder}/.`);
        const present = checks.map((c) => index.hasPath(c.expectedPath));

        const missingItems: PendingMediaItem[] = [];
        const byUser: VerifyReport["byUser"] = {};
        let reconcilable = 0;
        let presentCount = 0;

        for (let i = 0; i < checks.length; i++) {
          const c = checks[i];
          const isPresent = present[i];
          if (isPresent) {
            presentCount++;
            if (!c.claimedDownloaded) reconcilable++;
            continue;
          }
          missingItems.push({
            tweetId: c.tweetId,
            username: c.username,
            mediaIndex: c.mediaIndex,
            kind: c.kind,
            url: c.url,
          });
          const u = c.username || "unknown";
          if (!byUser[u]) byUser[u] = { missing: 0, photos: 0, videos: 0 };
          byUser[u].missing++;
          if (c.kind === "video") byUser[u].videos++;
          else byUser[u].photos++;
        }

        const report: VerifyReport = {
          source,
          folder,
          totalMedia: checks.length,
          presentCount,
          missingCount: missingItems.length,
          reconcilableCount: reconcilable,
          byUser,
          sample: missingItems.slice(0, 20).map((m) => ({
            tweetId: m.tweetId,
            username: m.username,
            mediaIndex: m.mediaIndex,
            kind: m.kind,
          })),
        };
        report.checkedAt = new Date().toISOString();
        if (missingItems.length > 0) {
          report.elsewhere = await downloadsElsewhere(downloadRoot, folder);
          for (const e of report.elsewhere) {
            appendLog(`Verify: ${e.count} ${folder}/media downloads recorded under ${e.dir}/ instead.`);
          }
        }
        // Dry run: keep the result for the popup to show whenever it's next
        // opened. A repair run consumes it (its items are now queued).
        if (dryRun) await saveVerifyReport(report);
        else await clearVerifyReport(source);

        appendLog(
          `Verify: ${presentCount}/${checks.length} present, ${missingItems.length} missing, ${reconcilable} reconcilable.`,
        );

        if (dryRun) {
          // Restore prior status — nothing changed on disk or in storage.
          runtime.status = prevStatus;
          runtime.currentPhase = null;
          await persistNow();
          return report;
        }

        // Repair pass: update manifest flags + populate pendingMedia.
        let flagsFlippedTrue = 0;
        let flagsFlippedFalse = 0;
        for (let i = 0; i < checks.length; i++) {
          const c = checks[i];
          const t = manifest.bookmarks[c.tweetId];
          const m = t?.media?.find((mm) => mm.index === c.mediaIndex);
          if (!m) continue;
          if (present[i] && !c.claimedDownloaded) {
            m.downloaded = true;
            flagsFlippedTrue++;
          } else if (!present[i] && c.claimedDownloaded) {
            m.downloaded = false;
            flagsFlippedFalse++;
          }
        }
        if (flagsFlippedTrue || flagsFlippedFalse) {
          appendLog(
            `Verify: reconciled ${flagsFlippedTrue} flags up, ${flagsFlippedFalse} flags down.`,
          );
          await saveManifest(manifest);
        }

        if (missingItems.length === 0) {
          runtime.status = "done";
          runtime.currentPhase = null;
          runtime.finishedAt = new Date().toISOString();
          appendLog(`Verify: ${source} fully verified — nothing missing.`);
          await persistNow();
          return report;
        }

        // Queue for the existing Download flow. Set runtime.options so runDownload
        // can find the right manifest + folder.
        pendingMedia = missingItems;
        recomputeSummary();
        await savePending(pendingMedia);
        runtime.options = {
          source,
          folder,
          maxPages: 1,
          incremental: false,
        };
        runtime.mediaTotal = 0;
        runtime.mediaDone = 0;
        runtime.mediaSkipped = 0;
        runtime.mediaErrored = 0;
        runtime.status = "ready";
        runtime.currentPhase = null;
        runtime.finishedAt = new Date().toISOString();
        appendLog(
          `Verify: ${missingItems.length} items queued for download — click Download to fetch.`,
        );
        await persistNow();
        return report;
      } catch (e) {
        runtime.status = "error";
        runtime.errorMessage = (e as Error).message ?? String(e);
        runtime.currentPhase = null;
        runtime.finishedAt = new Date().toISOString();
        appendLog(`Verify error: ${runtime.errorMessage}`);
        await persistNow();
        throw e;
      }
    }

    /**
     * Walk the user's CURRENT X bookmarks via the Bookmarks GraphQL endpoint,
     * paginating in newest-first cursor order, applying any @username filter,
     * and returning the items that should be unbookmarked according to the
     * requested order + cap.
     *
     * This is the live source of truth — unlike the previous manifest-based
     * version, what comes back here is guaranteed to be in the user's actual
     * bookmarks list at this moment, so we never hit the code-144 "_Missing"
     * errors caused by stale manifest entries.
     *
     * Early-stop for `newest-bookmarked-first`: as soon as we have `count`
     * matching items, stop paginating. Other orders need a full crawl
     * (oldest-first requires us to know where the list ends; tweet-date orders
     * require sorting the full set).
     */
    type CrawledCandidate = {
      id: string;
      username: string;
      displayName: string;
      createdAt?: string;
      text: string;
    };

    async function crawlBookmarksForCleanup(
      options: UnbookmarkOptions,
      manifest: Manifest,
      tombstones: Record<string, string>,
    ): Promise<CrawledCandidate[]> {
      const ep = captured.endpoints.Bookmarks;
      if (!captured.auth?.authorization || !captured.auth?.csrf) {
        throw new Error(
          "No auth captured. Visit x.com/i/history and scroll once so the extension can capture your session.",
        );
      }
      if (!ep) {
        throw new Error(
          "Bookmarks endpoint not captured yet. Open x.com/i/history and scroll once.",
        );
      }

      const filter =
        options.usernameFilter?.toLowerCase().replace(/^@/, "").trim() || "";
      const cap = Math.max(0, Math.min(1000, options.count));
      const canEarlyStop = options.order === "newest-bookmarked-first";
      // The "already handled" filter expires after 30 min. Long enough to ride
      // out X's eventual-consistency window (typically < 5 min) for back-to-
      // back cleanup runs, short enough that if the user re-bookmarks the same
      // tweet a while later they can clean it up again. Manual "Forget cleanup
      // history" provides an immediate escape hatch.
      const TOMBSTONE_TTL_MS = 30 * 60 * 1000;
      const nowMs = Date.now();

      const fetched: CrawledCandidate[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      let skippedAlreadyHandled = 0;
      const MAX_PAGES = 200; // 200 × ~100 = 20k bookmarks sanity ceiling

      while (pageCount < MAX_PAGES) {
        if (cancelFlag) break;
        pageCount++;
        runtime.pageCount = pageCount;
        appendLog(
          `Cleanup scan: page ${pageCount} (${fetched.length} matching, ${skippedAlreadyHandled} skipped-already-handled)…`,
        );
        await persist();

        const json = await fetchBookmarksPage({
          host: "x.com",
          queryId: ep.queryId,
          operation: "Bookmarks",
          cursor,
          captured,
        });
        const { entries, nextCursor } = extractEntries(json);

        for (const entry of entries) {
          const t = parseTweetEntry(entry);
          if (!t) continue;
          if (filter && t.username.toLowerCase() !== filter) continue;
          // Skip anything we've already unbookmarked WITHIN THE TTL WINDOW.
          // X has a brief eventual-consistency window (~minutes) where a just-
          // deleted bookmark can still appear in the next paginated response.
          // The TTL filter rides that out for back-to-back cleanup runs, but
          // expires after 30 min so a re-bookmarked tweet can be cleaned up
          // again later.
          //
          // Two signals consulted: the manifest's `unbookmarkedAt` stamp (for
          // items the user had synced before cleanup) AND the standalone
          // tombstones store (for items the user bookmarked fresh AFTER the
          // last sync). Sync clears the manifest stamp when it sees the item
          // is back on X, so usually the manifest signal is correct on its
          // own; the tombstone signal is the fallback for users who don't
          // sync between cleanup runs.
          const prior = manifest.bookmarks[t.id];
          const priorTs = prior?.unbookmarkedAt
            ? Date.parse(prior.unbookmarkedAt)
            : NaN;
          const tombTs = tombstones[t.id] ? Date.parse(tombstones[t.id]) : NaN;
          const recentPrior =
            !isNaN(priorTs) && nowMs - priorTs < TOMBSTONE_TTL_MS;
          const recentTomb =
            !isNaN(tombTs) && nowMs - tombTs < TOMBSTONE_TTL_MS;
          if (recentPrior || recentTomb) {
            skippedAlreadyHandled++;
            continue;
          }
          fetched.push({
            id: t.id,
            username: t.username,
            displayName: t.displayName,
            createdAt: t.createdAt,
            text: t.text,
          });
        }
        runtime.totalSeen = fetched.length;
        await persist();

        // Early-stop: we already have enough matching items and the cursor
        // order matches the requested output order.
        if (canEarlyStop && fetched.length >= cap) {
          appendLog(
            `Cleanup scan: ${fetched.length} matches collected — stopping early.`,
          );
          break;
        }
        if (!nextCursor || nextCursor === cursor) {
          appendLog(
            `Cleanup scan: end of bookmarks reached (${fetched.length} total matches).`,
          );
          break;
        }
        cursor = nextCursor;
        // Pacing matched to runSync's cadence.
        await sleep(1800 + Math.random() * 800);
      }

      // Sort to requested order. The cursor walks newest-first, so that's
      // already correct; other orders need explicit sort.
      switch (options.order) {
        case "newest-bookmarked-first":
          break; // cursor order
        case "oldest-bookmarked-first":
          fetched.reverse();
          break;
        case "newest-tweet-first":
          fetched.sort(
            (a, b) =>
              Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""),
          );
          break;
        case "oldest-tweet-first":
          fetched.sort(
            (a, b) =>
              Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""),
          );
          break;
      }
      return fetched.slice(0, cap);
    }

    /**
     * Live-crawl + unbookmark. Pure live-source-of-truth: walks the user's
     * CURRENT X bookmarks (not the local manifest), applies sort + filter +
     * cap, then either returns the preview (dry run) or deletes each one.
     *
     * Local manifest is touched ONLY to stamp `unbookmarkedAt` on entries the
     * user already had locally; we never modify media files, never remove
     * archive entries, never alter any other field. Tweets that X reports
     * but aren't in the local manifest get unbookmarked-on-X-only (no local
     * record to stamp — that's fine, the archive grows from future syncs).
     */
    async function runUnbookmark(
      options: UnbookmarkOptions,
      folder: string,
    ): Promise<UnbookmarkReport> {
      if (options.source !== "bookmarks") {
        throw new Error("Unbookmark only applies to the bookmarks source.");
      }
      if (
        runtime.status === "syncing" ||
        runtime.status === "downloading" ||
        runtime.status === "cancelling" ||
        runtime.status === "verifying" ||
        runtime.status === "unbookmarking"
      ) {
        throw new Error(
          `Cannot unbookmark while status is "${runtime.status}".`,
        );
      }

      cancelFlag = false;
      const prevStatus = runtime.status;
      runtime.status = "unbookmarking";
      runtime.currentPhase = "scanning";
      runtime.errorMessage = null;
      runtime.startedAt = new Date().toISOString();
      runtime.pageCount = 0;
      runtime.totalSeen = 0;
      runtime.mediaTotal = 0;
      runtime.mediaDone = 0;
      runtime.mediaErrored = 0;
      appendLog(
        `Cleanup ${options.dryRun ? "(preview)" : ""} · order=${options.order}${options.usernameFilter ? ` · @${options.usernameFilter}` : ""} · count=${options.count}`,
      );
      await persist();

      // Load the manifest + tombstones BEFORE the crawl so we can filter out
      // anything we've already handled in a prior run.
      const manifest = await loadManifest("bookmarks");
      const tombstones = await loadCleanupTombstones();

      let candidates: CrawledCandidate[];
      try {
        candidates = await crawlBookmarksForCleanup(
          options,
          manifest,
          tombstones,
        );
      } catch (e) {
        runtime.status = "error";
        runtime.errorMessage = (e as Error).message ?? String(e);
        runtime.currentPhase = null;
        runtime.finishedAt = new Date().toISOString();
        appendLog(`Cleanup scan failed: ${runtime.errorMessage}`);
        await persistNow();
        throw e;
      }

      const preview: UnbookmarkPreviewEntry[] = candidates.map((c) => ({
        id: c.id,
        username: c.username,
        displayName: c.displayName,
        createdAt: c.createdAt,
        text: c.text.length > 240 ? c.text.slice(0, 240) + "…" : c.text,
      }));

      if (options.dryRun) {
        runtime.status = prevStatus;
        runtime.currentPhase = null;
        await persistNow();
        const remaining = Object.values(manifest.bookmarks).filter(
          (b) => !b.unbookmarkedAt,
        ).length;
        return {
          preview,
          removed: [],
          alreadyGone: [],
          ghostsFixed: [],
          failed: [],
          remainingAfter: remaining,
        };
      }

      // Live run — capture for DeleteBookmark must be present.
      const ep = captured.endpoints.DeleteBookmark;
      if (!ep) {
        runtime.status = "error";
        runtime.errorMessage =
          "DeleteBookmark queryId not captured yet. Visit x.com/i/history, remove ONE bookmark manually, then retry.";
        runtime.currentPhase = null;
        runtime.finishedAt = new Date().toISOString();
        appendLog(runtime.errorMessage);
        await persistNow();
        throw new Error(runtime.errorMessage);
      }
      if (candidates.length === 0) {
        runtime.status = "done";
        runtime.currentPhase = null;
        runtime.finishedAt = new Date().toISOString();
        appendLog("Cleanup: 0 candidates after crawl — nothing to remove.");
        await persistNow();
        return {
          preview,
          removed: [],
          alreadyGone: [],
          ghostsFixed: [],
          failed: [],
          remainingAfter: Object.values(manifest.bookmarks).filter(
            (b) => !b.unbookmarkedAt,
          ).length,
        };
      }

      runtime.currentPhase = "backup";
      runtime.mediaTotal = candidates.length;
      await persist();

      // Always back up the manifest first.
      try {
        await backupManifestToDisk(folder, "bookmarks");
      } catch (e) {
        runtime.status = "error";
        runtime.errorMessage = `Backup failed before unbookmarking — aborting. ${(e as Error).message}`;
        appendLog(runtime.errorMessage);
        await persistNow();
        throw e;
      }

      runtime.currentPhase = "deleting";
      await persist();

      const removed: string[] = [];
      const alreadyGone: string[] = [];
      const ghostsFixed: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      let consecutiveFails = 0;
      const MAX_CONSECUTIVE_FAILS = 5;

      // Ghost-fix availability: needs the CreateBookmark mutation captured
      // (both queryId and body template — without the body we'd hit the same
      // request-shape pitfall we have with DeleteBookmark).
      const createEp = captured.endpoints.CreateBookmark;
      const ghostFixEnabled =
        !!options.fixGhosts && !!createEp && !!captured.createBookmarkBody;
      if (options.fixGhosts && !ghostFixEnabled) {
        // Loud about it: log + put it on runtime.errorMessage so the popup
        // banner shows it, not just the run log that's easy to miss.
        const missing: string[] = [];
        if (!createEp) missing.push("queryId");
        if (!captured.createBookmarkBody) missing.push("body shape");
        const msg =
          `Ghost-fix requested but CreateBookmark capture is incomplete (missing: ${missing.join(", ")}). ` +
          `Bookmark ANY tweet manually on x.com (the popup says "added to bookmarks"), then re-run cleanup. Proceeding without ghost-fix for now.`;
        appendLog(msg);
        runtime.errorMessage = msg;
      }
      if (ghostFixEnabled) {
        appendLog(
          "Ghost-fix enabled: '_Missing' responses will be retried via CreateBookmark.",
        );
      }

      for (const c of candidates) {
        if (cancelFlag) {
          appendLog("Cleanup cancelled.");
          break;
        }
        try {
          let result = await deleteBookmark(c.id, ep.queryId, captured);

          // Ghost-fix: if X says the bookmark store doesn't have this item but
          // X's bookmarks LIST showed it (else it wouldn't be in candidates),
          // force the stores into agreement by adding then removing.
          if (result === "already-gone" && ghostFixEnabled && createEp) {
            try {
              appendLog(`Ghost-fix attempt: ${c.id} (@${c.username})`);
              // Small pause so X doesn't see add+remove as one transaction.
              await sleep(400 + Math.random() * 200);
              await createBookmark(c.id, createEp.queryId, captured);
              await sleep(400 + Math.random() * 200);
              const retry = await deleteBookmark(c.id, ep.queryId, captured);
              if (retry === "removed") {
                ghostsFixed.push(c.id);
                result = "removed"; // for downstream bookkeeping
              } else {
                // Still a ghost after the add+remove dance — give up and
                // count as already-gone. Rare.
                alreadyGone.push(c.id);
                appendLog(
                  `Ghost-fix didn't help for ${c.id} — X still reports it missing.`,
                );
              }
            } catch (e) {
              // CreateBookmark or the retry delete blew up. Don't fail the
              // whole run — just record this one as alreadyGone and move on.
              alreadyGone.push(c.id);
              appendLog(
                `Ghost-fix failed for ${c.id}: ${(e as Error).message ?? e}`,
              );
            }
          } else if (result === "removed") {
            removed.push(c.id);
          } else {
            alreadyGone.push(c.id);
          }

          // Stamp the local entry if we have one. Don't create one if we don't
          // — that's outside the scope of cleanup; sync owns the archive.
          const entry = manifest.bookmarks[c.id];
          if (entry) entry.unbookmarkedAt = new Date().toISOString();
          consecutiveFails = 0;
        } catch (e) {
          const err = (e as Error).message ?? String(e);
          failed.push({ id: c.id, error: err });
          consecutiveFails++;
          appendLog(`× ${c.id} (@${c.username}): ${err}`);
          if (/HTTP 4(01|03)/.test(err)) {
            appendLog("Auth rejected — stopping. Refresh x.com and try again.");
            break;
          }
          if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
            appendLog(
              `${consecutiveFails} consecutive failures — stopping to avoid hammering X.`,
            );
            break;
          }
        }

        runtime.mediaDone =
          removed.length + alreadyGone.length + ghostsFixed.length;
        runtime.mediaErrored = failed.length;
        if (
          (removed.length +
            alreadyGone.length +
            ghostsFixed.length +
            failed.length) %
            5 ===
          0
        ) {
          await saveManifest(manifest);
          await persist();
        }

        if (!cancelFlag) {
          // Pacing between DeleteBookmark calls. X's actual rate-limit ceiling
          // for this mutation is well above 1/sec — this is a "look like a
          // human clicking unbookmark" interval. Tuned from initial 1500-2500
          // (very conservative, felt frozen) to 800-1400 (still well under
          // any observed limit).
          await sleep(800 + Math.random() * 600);
        }
      }

      await saveManifest(manifest);
      // Tombstone EVERY id we handled — including items we didn't have in
      // the manifest (the user bookmarked them after the last sync). This is
      // the only persistent record for those, and is what stops the next
      // crawl from picking them up again during X's eventual-consistency
      // window.
      await addCleanupTombstones([...removed, ...alreadyGone, ...ghostsFixed]);
      // Regenerate snapshots so the explorer reflects the unbookmarkedAt stamps.
      try {
        await writeSource(folder, manifest);
        await writeMasterIndex(folder);
      } catch {}

      runtime.status = cancelFlag ? "cancelled" : "done";
      runtime.currentPhase = null;
      runtime.finishedAt = new Date().toISOString();
      appendLog(
        `Cleanup done. ${removed.length} removed, ${ghostsFixed.length} ghosts fixed, ${alreadyGone.length} already gone on X, ${failed.length} failed.`,
      );
      await persistNow();

      const remaining = Object.values(manifest.bookmarks).filter(
        (b) => !b.unbookmarkedAt,
      ).length;
      return {
        preview,
        removed,
        alreadyGone,
        ghostsFixed,
        failed,
        remainingAfter: remaining,
      };
    }

    async function auditAgainstChromeDownloads(
      manifest: Manifest,
      folder: string,
      downloadRoot: string,
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
      const index = await buildDownloadIndex(downloadRoot, folder);
      const results = pending.map((p) => index.hasUrlAt(p.url, p.expectedPath));
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
                  hasBookmarks: !!captured.endpoints.Bookmarks,
                  hasUserByScreenName: !!captured.endpoints.UserByScreenName,
                  hasUserTweets: !!captured.endpoints.UserTweets,
                  hasUserMedia:
                    !!captured.endpoints.UserMedia ||
                    Object.keys(captured.userMedia ?? {}).length > 0,
                  userMediaVariants: sortMediaVariants(
                    Object.keys(captured.userMedia ?? {}),
                  ),
                  userMediaOps: [
                    ...new Set(
                      Object.values(captured.userMedia ?? {}).map(
                        (r) => r.operation,
                      ),
                    ),
                  ].sort(),
                  hasDeleteBookmark: !!captured.endpoints.DeleteBookmark,
                  hasCreateBookmark: !!captured.endpoints.CreateBookmark,
                  hasDeleteBookmarkBody: !!captured.deleteBookmarkBody,
                  hasCreateBookmarkBody: !!captured.createBookmarkBody,
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
              } else if (runtime.status === "unbookmarking") {
                // Cleanup uses the same cancelFlag — flipping it makes the
                // crawl loop and delete loop both exit at the next iteration.
                cancelFlag = true;
                appendLog("Cleanup cancel requested.");
                await persistNow();
              }
              sendResponse({ ok: true });
              return;
            }
            case "clearManifest": {
              // Source-aware so the popup can wipe just the active source.
              await clearManifest(
                (msg.source as SourceKey | undefined) ?? "bookmarks",
              );
              sendResponse({ ok: true });
              return;
            }
            case "getManifest": {
              const m = await loadManifest(
                (msg.source as SourceKey | undefined) ?? "bookmarks",
              );
              sendResponse({ ok: true, manifest: m });
              return;
            }
            case "listSources": {
              const sources = await listSources();
              sendResponse({ ok: true, sources });
              return;
            }
            case "unbookmark": {
              if (!msg.options || msg.options.source !== "bookmarks") {
                sendResponse({
                  ok: false,
                  error: "unbookmark: source must be 'bookmarks'",
                });
                return;
              }
              try {
                const folder =
                  (msg.folder as string) || runtime.options?.folder || "xshelf";
                const report = await runUnbookmark(
                  msg.options as UnbookmarkOptions,
                  folder,
                );
                sendResponse({ ok: true, report });
              } catch (e) {
                sendResponse({
                  ok: false,
                  error: (e as Error).message ?? String(e),
                });
              }
              return;
            }
            case "clearCleanupHistory": {
              await clearCleanupTombstones();
              appendLog(
                "Cleanup history cleared — past unbookmarks won't be filtered next run.",
              );
              await persistNow();
              sendResponse({ ok: true });
              return;
            }
            case "rebuildExplorer": {
              if (
                runtime.status === "syncing" ||
                runtime.status === "downloading" ||
                runtime.status === "cancelling" ||
                runtime.status === "verifying"
              ) {
                sendResponse({
                  ok: false,
                  error: `Wait for the current run to finish (status "${runtime.status}").`,
                });
                return;
              }
              try {
                const folder = (msg.folder as string) || "xshelf";
                await probeDownloadRoot(folder);
                // Only the two explorer pages: they read the existing
                // per-source data.js files (rewritten by each sync), so
                // there's no need to re-download every source's data here.
                await writeMasterIndex(folder);
                await persist();
                sendResponse({ ok: true });
              } catch (e) {
                sendResponse({
                  ok: false,
                  error: (e as Error).message ?? String(e),
                });
              }
              return;
            }
            case "backupManifest": {
              try {
                const folder = (msg.folder as string) || "xshelf";
                const path = await backupManifestToDisk(folder, "bookmarks");
                sendResponse({ ok: true, path });
              } catch (e) {
                sendResponse({
                  ok: false,
                  error: (e as Error).message ?? String(e),
                });
              }
              return;
            }
            case "importMissingList": {
              if (
                runtime.status === "syncing" ||
                runtime.status === "downloading" ||
                runtime.status === "cancelling" ||
                runtime.status === "verifying"
              ) {
                sendResponse({
                  ok: false,
                  error: `Cannot import while status is "${runtime.status}".`,
                });
                return;
              }
              if (!msg.source || !Array.isArray(msg.items)) {
                sendResponse({
                  ok: false,
                  error: "importMissingList: missing source or items",
                });
                return;
              }
              if (pendingMedia.length > 0) {
                sendResponse({
                  ok: false,
                  error: `${pendingMedia.length} items already pending — download or discard them first.`,
                });
                return;
              }
              const src = msg.source as SourceKey;
              const folder = (msg.folder as string) || "xshelf";
              const items = msg.items as Array<{
                tweetId: string;
                username: string;
                mediaIndex: number;
                kind: "photo" | "video";
                url: string;
                sources?: SourceKey[];
              }>;
              // A v2 list spans sources (the media tree is shared), so flags
              // are updated in every manifest the item belongs to.
              const manifests = new Map<SourceKey, Manifest>();
              const manifestFor = async (k: SourceKey) => {
                let m = manifests.get(k);
                if (!m) {
                  m = await loadManifest(k);
                  manifests.set(k, m);
                }
                return m;
              };
              const queued: PendingMediaItem[] = [];
              const seenKey = new Set<string>();
              let skipped = 0;
              for (const it of items) {
                const itemSources = it.sources?.length ? it.sources : [src];
                let t: Bookmark | undefined;
                let m: Media | undefined;
                for (const k of itemSources) {
                  const mt = (await manifestFor(k)).bookmarks[it.tweetId];
                  const mm = mt?.media?.find((x) => x.index === it.mediaIndex);
                  // Mark "not downloaded" so the explorers reflect reality;
                  // the download step flips it back on success.
                  if (mm) mm.downloaded = false;
                  t ??= mt;
                  m ??= mm;
                }
                // Prefer the URL we have in the manifest (it's the freshest);
                // fall back to the URL the explorer included.
                const url = m?.url || it.url;
                if (!url) {
                  skipped++;
                  continue;
                }
                const key = `${it.tweetId}_${it.mediaIndex}`;
                if (seenKey.has(key)) {
                  skipped++;
                  continue;
                }
                seenKey.add(key);
                queued.push({
                  tweetId: it.tweetId,
                  username: it.username || t?.username || "unknown",
                  mediaIndex: it.mediaIndex,
                  kind: it.kind,
                  url,
                  ...(it.sources?.length ? { sources: it.sources } : {}),
                });
              }
              // Disk-scan lists also carry what IS on disk: mark those
              // downloaded, so flags match the drive in both directions.
              let reconciled = 0;
              for (const [tweetId, mediaIndex, srcs] of (msg.present ?? []) as Array<
                [string, number, SourceKey[]]
              >) {
                for (const k of srcs?.length ? srcs : [src]) {
                  const mm = (await manifestFor(k)).bookmarks[tweetId]?.media?.find(
                    (x) => x.index === mediaIndex,
                  );
                  if (mm && !mm.downloaded) {
                    mm.downloaded = true;
                    reconciled++;
                  }
                }
              }
              for (const m of manifests.values()) await saveManifest(m);
              if (reconciled > 0 || queued.length > 0) {
                // Refresh what the explorers read so "missing" filters match.
                for (const m of manifests.values()) await writeSourceDataJs(folder, m);
                await writeMasterIndex(folder);
              }
              if (queued.length === 0) {
                appendLog(
                  `Import: nothing missing; ${reconciled} flag${reconciled === 1 ? "" : "s"} corrected (${skipped} skipped).`,
                );
                await persistNow();
                sendResponse({ ok: true, queued: 0, skipped, reconciled });
                return;
              }
              pendingMedia = queued;
              await savePending(pendingMedia);
              runtime.options = {
                source: src,
                folder,
                maxPages: 1,
                incremental: false,
              };
              runtime.mediaTotal = 0;
              runtime.mediaDone = 0;
              runtime.mediaSkipped = 0;
              runtime.mediaErrored = 0;
              runtime.status = "ready";
              runtime.currentPhase = null;
              runtime.errorMessage = null;
              runtime.finishedAt = new Date().toISOString();
              recomputeSummary();
              appendLog(
                `Import: ${queued.length} item${queued.length === 1 ? "" : "s"} queued for download, ${reconciled} flag${reconciled === 1 ? "" : "s"} corrected (${skipped} skipped).`,
              );
              await persistNow();
              sendResponse({ ok: true, queued: queued.length, skipped, reconciled });
              return;
            }
            case "verifySource": {
              if (!msg.source) {
                sendResponse({
                  ok: false,
                  error: "verifySource: missing source",
                });
                return;
              }
              const folder =
                (msg.folder as string) || runtime.options?.folder || "xshelf";
              try {
                const report = await runVerify(
                  msg.source as SourceKey,
                  folder,
                  !!msg.dryRun,
                );
                sendResponse({ ok: true, report });
              } catch (e) {
                sendResponse({
                  ok: false,
                  error: (e as Error).message ?? String(e),
                });
              }
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
