// Service worker is now the *server*: owns the run loop, persists state, survives
// the popup opening and closing. The popup is just a status panel.

const XBD_SW_VERSION = "v8-sort-fix"; // bump when adding messages so popup can detect stale SW

// === KEYS ===
const RUN_STATE_KEY = "xbd_runState";
const MANIFEST_KEY = "xbd_manifest_v1";
const CAPTURED_KEY = "xbd_captured_v1";
const PENDING_KEY = "xbd_pending_v1"; // heavy: stored separately to keep hot path light

// === RUNTIME STATE (persisted) ===
function freshState() {
  return {
    // idle | syncing | ready | downloading | cancelling | cancelled | done | error | interrupted
    status: "idle",
    startedAt: null,
    finishedAt: null,
    currentPhase: null,
    options: null,
    pageCount: 0,
    totalSeen: 0,
    newCount: 0,
    totalKnown: 0,
    mediaTotal: 0,
    mediaDone: 0,
    mediaSkipped: 0,
    mediaErrored: 0,
    errorMessage: null,
    // Lightweight summary of the pending list — what the popup UI needs.
    // The actual heavy array lives in chrome.storage.local under PENDING_KEY (not in runtime).
    pendingSummary: { count: 0, tweetCount: 0, photoCount: 0, videoCount: 0, byUser: {} },
    log: []
  };
}
let runtime = freshState();
let pendingMedia = []; // in-memory only; persisted separately via savePending()
let cancelFlag = false;

// Throttled, async storage write + broadcast. Many call sites hit persist() rapidly
// (every page during sync, every 5 items during download); without throttling each one
// did a JSON.stringify of the full state and an IPC broadcast, which lagged the browser
// when pendingMedia was thousands of items long. Now `persist()` only enqueues a flush.
let persistTimer = null;
let persistQueued = false;
async function persist() {
  persistQueued = true;
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersist, 200);
}
async function flushPersist() {
  persistTimer = null;
  if (!persistQueued) return;
  persistQueued = false;
  // Snapshot at flush time (after any synchronous mutations in this tick).
  const snap = runtime;
  try {
    await chrome.storage.local.set({ [RUN_STATE_KEY]: snap });
    chrome.runtime.sendMessage({ type: "stateUpdate", state: snap }).catch(() => {});
  } catch {}
}
async function persistNow() {
  // For end-of-phase: bypass throttle and wait for the write to complete.
  persistQueued = false;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  await chrome.storage.local.set({ [RUN_STATE_KEY]: runtime });
  chrome.runtime.sendMessage({ type: "stateUpdate", state: runtime }).catch(() => {});
}

async function savePending() {
  // Only call at phase boundaries / coarse checkpoints — never every iteration.
  await chrome.storage.local.set({ [PENDING_KEY]: pendingMedia });
}
async function loadPending() {
  const d = await chrome.storage.local.get(PENDING_KEY);
  pendingMedia = Array.isArray(d[PENDING_KEY]) ? d[PENDING_KEY] : [];
}
async function clearPending() {
  pendingMedia = [];
  await chrome.storage.local.remove(PENDING_KEY);
}

function recomputeSummary() {
  const byUser = {};
  let photos = 0, videos = 0;
  const tweetIds = new Set();
  for (const p of pendingMedia) {
    tweetIds.add(p.tweetId);
    const u = p.username || "unknown";
    if (!byUser[u]) byUser[u] = { count: 0, photos: 0, videos: 0 };
    byUser[u].count++;
    if (p.kind === "video") { byUser[u].videos++; videos++; }
    else { byUser[u].photos++; photos++; }
  }
  runtime.pendingSummary = {
    count: pendingMedia.length,
    tweetCount: tweetIds.size,
    photoCount: photos,
    videoCount: videos,
    byUser
  };
}

function appendLog(line) {
  const ts = new Date().toLocaleTimeString();
  runtime.log.push(`[${ts}] ${line}`);
  while (runtime.log.length > 120) runtime.log.shift();
}

async function loadPersisted() {
  const data = await chrome.storage.local.get([RUN_STATE_KEY, CAPTURED_KEY, PENDING_KEY]);
  if (data[RUN_STATE_KEY]) {
    runtime = { ...freshState(), ...data[RUN_STATE_KEY] };
    // Older versions stored pendingMedia inside runtime — ignore it; the new key is authoritative.
    delete runtime.pendingMedia;
    delete runtime.pendingByUser;
  }
  if (Array.isArray(data[PENDING_KEY])) pendingMedia = data[PENDING_KEY];
  recomputeSummary();
  if (runtime.status === "syncing" || runtime.status === "cancelling") {
    runtime.status = "interrupted";
    runtime.errorMessage = "Service worker was restarted mid-sync. Click Start sync to resume.";
    appendLog(runtime.errorMessage);
    await persistNow();
  } else if (runtime.status === "downloading") {
    if (pendingMedia.length > 0) {
      runtime.status = "ready";
      runtime.errorMessage = null;
      appendLog(`Service worker restarted mid-download. ${pendingMedia.length} items still pending — click Download to resume.`);
    } else {
      runtime.status = "done";
    }
    await persistNow();
  }
  if (data[CAPTURED_KEY]) {
    captured = { ...captured, ...data[CAPTURED_KEY] };
    if (captured.operation && (/BookmarkFolders/i.test(captured.operation) || /UpdateBookmark/i.test(captured.operation))) {
      captured.operation = null;
      captured.queryId = null;
      await persistCaptured();
    }
  }
}

// === CAPTURED AUTH + ENDPOINT ===
let captured = { auth: null, queryId: null, operation: null };

async function persistCaptured() {
  await chrome.storage.local.set({ [CAPTURED_KEY]: captured });
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    let touched = false;
    const auth = { ...(captured.auth || {}) };
    for (const h of details.requestHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === "authorization") { auth.authorization = h.value; touched = true; }
      else if (name === "x-csrf-token") { auth.csrf = h.value; touched = true; }
    }
    if (touched && auth.authorization && auth.csrf) {
      captured.auth = auth;
    }
    const m = details.url.match(/\/i\/api\/graphql\/([^/?]+)\/([^/?]*Bookmark[^/?]*)/i);
    if (m) {
      const op = m[2];
      // Reject ops that aren't the bookmarks timeline. BookmarkFoldersSlice is the
      // sidebar-folder-list call; folder management operations don't return tweets.
      const isFolderOnly =
        /BookmarkFolders/i.test(op) ||
        /CreateBookmarkFolder/i.test(op) ||
        /DeleteBookmarkFolder/i.test(op) ||
        /UpdateBookmark/i.test(op);
      // Prefer the canonical "Bookmarks" operation. Accept others (e.g. BookmarkFolderTimeline
      // for a specific folder view) only if we don't already have something better.
      const isCanonical = /^Bookmarks$/.test(op);
      if (!isFolderOnly) {
        if (isCanonical || !captured.operation || /BookmarkFolders/i.test(captured.operation)) {
          captured.queryId = m[1];
          captured.operation = op;
          touched = true;
        }
      }
    }
    if (touched) persistCaptured();
  },
  {
    urls: [
      "https://x.com/i/api/*",
      "https://twitter.com/i/api/*",
      "https://api.x.com/*",
      "https://api.twitter.com/*"
    ]
  },
  ["requestHeaders", "extraHeaders"]
);

// === DOWNLOAD TRACKING (URL-keyed for reliable cancel) ===
const xbdByUrl = new Map();
const xbdById = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  const ours = xbdById.get(delta.id);
  if (!ours) return;
  if (delta.state && delta.state.current === "complete") {
    ours.resolve(delta.id);
    cleanup(ours);
  } else if (delta.state && delta.state.current === "interrupted") {
    ours.reject(new Error((delta.error && delta.error.current) || "interrupted"));
    cleanup(ours);
  }
});

function cleanup(entry) {
  if (entry.id != null) xbdById.delete(entry.id);
  for (const [u, v] of xbdByUrl.entries()) if (v === entry) xbdByUrl.delete(u);
}

async function downloadFile(url, filename, conflictAction = "overwrite") {
  return new Promise((resolve, reject) => {
    const entry = { filename, conflictAction, resolve, reject, id: null };
    xbdByUrl.set(url, entry);
    chrome.downloads.download(
      { url, filename, conflictAction, saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) { cleanup(entry); reject(new Error(err.message)); return; }
        if (typeof id !== "number") { cleanup(entry); reject(new Error("no download id")); return; }
        entry.id = id;
        xbdById.set(id, entry);
      }
    );
  });
}

async function cancelAllDownloads() {
  const ids = [...xbdById.keys()];
  for (const id of ids) {
    try { await chrome.downloads.cancel(id); } catch {}
  }
  for (const entry of new Set(xbdByUrl.values())) {
    try { entry.reject(new Error("cancelled")); } catch {}
  }
  xbdByUrl.clear();
  xbdById.clear();
}

// === MANIFEST ===
async function loadManifest() {
  const d = await chrome.storage.local.get(MANIFEST_KEY);
  return d[MANIFEST_KEY] || { version: 1, bookmarks: {}, lastRun: null };
}
async function saveManifest(m) {
  await chrome.storage.local.set({ [MANIFEST_KEY]: m });
}

// === EXISTENCE CHECK (works around regex pitfall in chrome.downloads.search) ===
async function existsByUrl(url) {
  try {
    const items = await chrome.downloads.search({ url, state: "complete", limit: 1 });
    return items && items.length > 0;
  } catch {
    return false;
  }
}

// Run an async fn over `items` with bounded concurrency so we don't fire
// thousands of chrome.downloads.search calls at once (which freezes Chrome).
async function mapLimited(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch { results[i] = undefined; }
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, items.length);
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// === BOOKMARKS GRAPHQL ===
const BOOKMARKS_FEATURES = {
  graphql_timeline_v2_bookmark_timeline: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false
};

async function fetchBookmarksPage({ host, queryId, operation, cursor }) {
  const variables = { count: 100, includePromotedContent: false };
  if (cursor) variables.cursor = cursor;
  const url = new URL(`https://${host}/i/api/graphql/${queryId}/${operation}`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(BOOKMARKS_FEATURES));

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include", // sends user's x.com cookies (we have host_permissions)
    headers: {
      "authorization": captured.auth.authorization,
      "x-csrf-token": captured.auth.csrf,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
      "content-type": "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bookmarks request failed: HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  return res.json();
}

function extractEntries(json) {
  const root = json && json.data && json.data.bookmark_timeline_v2 && json.data.bookmark_timeline_v2.timeline;
  const instructions = (root && root.instructions) || [];
  let entries = [];
  for (const ins of instructions) {
    if (ins.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      entries = entries.concat(ins.entries);
    }
  }
  let nextCursor = null;
  for (const e of entries) {
    const c = e && e.content;
    if (c && c.entryType === "TimelineTimelineCursor" && c.cursorType === "Bottom") nextCursor = c.value;
  }
  const tweetEntries = entries.filter((e) => e && e.content && e.content.entryType === "TimelineTimelineItem");
  return { entries: tweetEntries, nextCursor };
}

function parseTweetEntry(entry) {
  try {
    const item = entry.content && entry.content.itemContent;
    if (!item || item.itemType !== "TimelineTweet") return null;
    const tr = item.tweet_results && item.tweet_results.result;
    if (!tr) return null;
    const tweet = tr.__typename === "TweetWithVisibilityResults" ? tr.tweet : tr;
    if (!tweet || !tweet.legacy) return null;

    const legacy = tweet.legacy;
    const userResult = tweet.core && tweet.core.user_results && tweet.core.user_results.result;
    const userLegacy = userResult && userResult.legacy;
    const username = (userLegacy && userLegacy.screen_name) || (userResult && userResult.core && userResult.core.screen_name) || "unknown";
    const displayName = (userLegacy && userLegacy.name) || (userResult && userResult.core && userResult.core.name) || "";

    const id = legacy.id_str || tweet.rest_id;
    const text =
      (tweet.note_tweet &&
        tweet.note_tweet.note_tweet_results &&
        tweet.note_tweet.note_tweet_results.result &&
        tweet.note_tweet.note_tweet_results.result.text) ||
      legacy.full_text ||
      "";
    const media = [];
    const mediaArr =
      (legacy.extended_entities && legacy.extended_entities.media) ||
      (legacy.entities && legacy.entities.media) ||
      [];
    mediaArr.forEach((m, i) => {
      if (m.type === "photo") {
        media.push({ kind: "photo", index: i, url: toOrigPhoto(m.media_url_https) });
      } else if (m.type === "video" || m.type === "animated_gif") {
        const variants = (m.video_info && m.video_info.variants) || [];
        const mp4s = variants.filter((v) => v.content_type === "video/mp4" && typeof v.bitrate === "number");
        mp4s.sort((a, b) => b.bitrate - a.bitrate);
        const best = mp4s[0] || variants[0];
        if (best && best.url) media.push({ kind: "video", index: i, url: best.url });
      }
    });

    return {
      id,
      url: `https://x.com/${username}/status/${id}`,
      username,
      displayName,
      createdAt: legacy.created_at,
      text,
      lang: legacy.lang,
      replyCount: legacy.reply_count,
      retweetCount: legacy.retweet_count,
      favoriteCount: legacy.favorite_count,
      quoteCount: legacy.quote_count,
      media
    };
  } catch {
    return null;
  }
}

function toOrigPhoto(u) {
  try {
    const url = new URL(u);
    const fmtMatch = url.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
    if (fmtMatch) {
      const fmt = fmtMatch[1].toLowerCase();
      const base = url.origin + url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, "");
      return `${base}?format=${fmt === "jpeg" ? "jpg" : fmt}&name=orig`;
    }
    url.searchParams.set("name", "orig");
    return url.toString();
  } catch {
    return u;
  }
}

function extFromUrl(u) {
  try {
    const url = new URL(u);
    const fmt = url.searchParams.get("format");
    if (fmt) return fmt;
    const m = url.pathname.match(/\.([a-z0-9]+)(?:$|\?)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sanitize(s) {
  return String(s || "unknown").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 60) || "unknown";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function allMediaDownloaded(entry) {
  if (!entry.media || entry.media.length === 0) return true;
  return entry.media.every((m) => m.downloaded);
}

// === SYNC PHASE: fetch metadata, reconcile against disk, build pendingMedia ===
async function runSync(options) {
  if (runtime.status === "syncing" || runtime.status === "downloading" || runtime.status === "cancelling") return;
  cancelFlag = false;
  // Single timestamp for THIS sync. Every bookmark visited in this run gets the
  // same `lastSeenAt`, so the sort key (lastSeenAt DESC, lastSeenIndex ASC) is
  // determined purely by encounter index within the sync. Using a per-tweet
  // `new Date()` would make later-processed (older) bookmarks appear newer.
  const syncStartedIso = new Date().toISOString();
  runtime = { ...freshState(), status: "syncing", startedAt: syncStartedIso, options };
  pendingMedia = [];
  await clearPending();
  appendLog(`Sync → ${options.folder}/  (maxPages=${options.maxPages}, incremental=${options.incremental})`);
  await persist();

  try {
    if (!captured.auth || !captured.auth.authorization || !captured.auth.csrf) {
      throw new Error("No auth captured yet. Open https://x.com/i/bookmarks (or refresh it) so the extension can observe the request.");
    }
    if (!captured.queryId || !captured.operation) {
      throw new Error("No bookmark endpoint captured yet. Open https://x.com/i/bookmarks and scroll once.");
    }
    if (/BookmarkFolders/i.test(captured.operation) || /UpdateBookmark/i.test(captured.operation)) {
      throw new Error(`Captured the wrong endpoint (${captured.operation}). Open https://x.com/i/bookmarks (the main list, not a folder) and scroll once so the page makes a real Bookmarks request.`);
    }
    appendLog(`Endpoint: ${captured.operation} (queryId=${captured.queryId})`);
    await persist();

    const manifest = await loadManifest();
    runtime.totalKnown = Object.keys(manifest.bookmarks).length;
    appendLog(`History: ${runtime.totalKnown} bookmarks already tracked.`);
    await persist();

    // ---- Audit pass ----
    if (options.incremental && runtime.totalKnown > 0) {
      runtime.currentPhase = "audit";
      await persist();
      const reconciled = await auditAgainstChromeDownloads(manifest);
      if (reconciled > 0) {
        appendLog(`Audit reconciled ${reconciled} files (already on disk; won't re-download).`);
        await saveManifest(manifest);
      } else {
        appendLog("Audit: nothing new to reconcile.");
      }
      await persist();
    }

    // ---- Pagination ----
    runtime.currentPhase = "fetch";
    await persist();
    let cursor = null;
    const queuedKey = new Set();
    let consecutiveKnown = 0;
    let stoppedEarly = false;
    const earlyStopAfter = options.earlyStopAfter || 30;
    // Position within this sync's API encounter order (newest-bookmarked first).
    // Combined with lastSeenAt this gives a true "newest bookmarked" sort:
    // newer sync = newer lastSeenAt; within sync, lower index = newer bookmark.
    let syncEncounterIndex = 0;

    // One-time backfill: assign a stable ordering to legacy bookmarks that don't have
    // lastSeenIndex yet. We use the manifest's key insertion order, which on the
    // original sync was the same as X's newest-first response.
    {
      const ids = Object.keys(manifest.bookmarks);
      const needsBackfill = ids.some((id) => manifest.bookmarks[id].lastSeenIndex == null);
      if (needsBackfill) {
        appendLog("Backfilling sort ordering for legacy entries…");
        let backfilled = 0;
        ids.forEach((id, idx) => {
          const b = manifest.bookmarks[id];
          if (b.lastSeenIndex == null) {
            b.lastSeenIndex = idx + 1;
            if (!b.lastSeenAt) b.lastSeenAt = b.firstSeenAt || "1970-01-01T00:00:00.000Z";
            backfilled++;
          }
        });
        if (backfilled) appendLog(`Backfilled ${backfilled} entries.`);
        await saveManifest(manifest);
      }
    }

    while (runtime.pageCount < options.maxPages) {
      if (cancelFlag) break;
      runtime.pageCount++;
      appendLog(`Page ${runtime.pageCount}…`);
      await persist();

      let json;
      try {
        json = await fetchBookmarksPage({ host: "x.com", queryId: captured.queryId, operation: captured.operation, cursor });
      } catch (e) {
        if (/HTTP 404/.test(e.message) && /Query not found/i.test(e.message)) {
          appendLog("404 — endpoint rotated. Refresh https://x.com/i/bookmarks then click Start sync again.");
        }
        throw e;
      }
      const { entries, nextCursor } = extractEntries(json);
      let newOnPage = 0;

      for (const entry of entries) {
        const tweet = parseTweetEntry(entry);
        if (!tweet) continue;
        runtime.totalSeen++;
        const existing = manifest.bookmarks[tweet.id];
        const nowIso = syncStartedIso; // single timestamp for whole sync (sort correctness)

        if (existing && options.incremental && allMediaDownloaded(existing)) {
          syncEncounterIndex++;
          // Re-stamp ordering keys on every visit; this is what powers the
          // "newest bookmarked" sort in the explorer.
          existing.lastSeenAt = nowIso;
          existing.lastSeenIndex = syncEncounterIndex;
          existing.replyCount = tweet.replyCount;
          existing.retweetCount = tweet.retweetCount;
          existing.favoriteCount = tweet.favoriteCount;
          existing.quoteCount = tweet.quoteCount;
          consecutiveKnown++;
          if (consecutiveKnown >= earlyStopAfter) {
            stoppedEarly = true;
            appendLog(`${consecutiveKnown} consecutive known tweets — stopping early.`);
            break;
          }
        } else {
          consecutiveKnown = 0;
          const mergedMedia = (tweet.media || []).map((m, i) => {
            const prior = existing && existing.media && existing.media[i];
            return { kind: m.kind, index: m.index, url: m.url, downloaded: !!(prior && prior.downloaded) };
          });
          syncEncounterIndex++;
          const merged = {
            ...tweet,
            media: mergedMedia,
            firstSeenAt: existing ? existing.firstSeenAt : nowIso,
            // lastSeenAt + lastSeenIndex are the sort keys; re-stamped on every visit.
            lastSeenAt: nowIso,
            lastSeenIndex: syncEncounterIndex
          };
          manifest.bookmarks[tweet.id] = merged;
          if (!existing) { runtime.newCount++; newOnPage++; }
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
              url: m.url
            });
          }
        }
      }

      runtime.totalKnown = Object.keys(manifest.bookmarks).length;
      appendLog(`Page ${runtime.pageCount}: seen=${runtime.totalSeen}, new=${runtime.newCount}, +${newOnPage} this page, pending=${pendingMedia.length}.`);
      // Update summary so the popup can render progress without seeing the heavy list.
      recomputeSummary();
      await persist();
      await saveManifest(manifest);

      if (stoppedEarly) break;
      if (!nextCursor || nextCursor === cursor || entries.length === 0) break;
      cursor = nextCursor;
      await sleep(800 + Math.random() * 600);
    }

    // ---- Pre-flight: drop pending entries already in Chrome's download history ----
    if (options.incremental && pendingMedia.length) {
      runtime.currentPhase = "preflight";
      appendLog(`Pre-flight: checking ${pendingMedia.length} URLs against download history…`);
      await persist();
      const results = await mapLimited(
        pendingMedia,
        4,
        (p) => cancelFlag ? false : existsByUrl(p.url),
        (done, total) => { appendLog(`Pre-flight progress: ${done}/${total}`); persist(); }
      );
      let skipped = 0;
      for (let i = 0; i < pendingMedia.length; i++) {
        if (results[i]) {
          const t = manifest.bookmarks[pendingMedia[i].tweetId];
          const m = t && t.media && t.media.find((mm) => mm.index === pendingMedia[i].mediaIndex);
          if (m) m.downloaded = true;
          pendingMedia[i]._skip = true;
          skipped++;
        }
      }
      pendingMedia = pendingMedia.filter((p) => !p._skip);
      runtime.mediaSkipped = skipped;
      if (skipped > 0) {
        appendLog(`Pre-flight skipped ${skipped} URLs already on disk per download history.`);
        await saveManifest(manifest);
      }
      recomputeSummary();
      await persist();
    }

    // Final pending list summary; persist the heavy array once at the end of sync.
    recomputeSummary();
    await savePending();

    // ---- Update manifest.lastRun and write index files ----
    manifest.lastRun = {
      finishedAt: new Date().toISOString(),
      pages: runtime.pageCount,
      seen: runtime.totalSeen,
      newCount: runtime.newCount,
      stoppedEarly,
      phase: "sync"
    };
    await saveManifest(manifest);
    await writeIndexFiles(options.folder, manifest);

    runtime.totalKnown = Object.keys(manifest.bookmarks).length;
    runtime.finishedAt = new Date().toISOString();
    runtime.currentPhase = null;

    if (cancelFlag) {
      runtime.status = "cancelled";
      appendLog(`Cancelled during sync. ${pendingMedia.length} items in pending list.`);
    } else if (pendingMedia.length === 0) {
      runtime.status = "done";
      appendLog(`Sync done. Nothing new to download. seen=${runtime.totalSeen}, total=${runtime.totalKnown}.`);
    } else {
      runtime.status = "ready";
      appendLog(`Sync done. ${pendingMedia.length} media items pending. Click Download to fetch, or Discard.`);
    }
    await persistNow();
  } catch (e) {
    runtime.status = "error";
    runtime.errorMessage = e.message;
    runtime.finishedAt = new Date().toISOString();
    runtime.currentPhase = null;
    appendLog(`Error: ${e.message}`);
    await persist();
  }
}

// === DOWNLOAD PHASE: fetch the bytes for everything in pendingMedia ===
async function runDownload() {
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

  const folder = (runtime.options && runtime.options.folder) || "x-bookmarks";
  const manifest = await loadManifest();

  try {
    while (pendingMedia.length > 0) {
      if (cancelFlag) break;
      const item = pendingMedia[0];
      const ext = item.kind === "video" ? "mp4" : (extFromUrl(item.url) || "jpg");
      const safeUser = sanitize(item.username);
      const filename = `${folder}/media/${safeUser}/${item.tweetId}_${item.mediaIndex}.${ext}`;
      try {
        await downloadFile(item.url, filename, "overwrite");
        const t = manifest.bookmarks[item.tweetId];
        const m = t && t.media && t.media.find((mm) => mm.index === item.mediaIndex);
        if (m) m.downloaded = true;
      } catch (e) {
        runtime.mediaErrored++;
        appendLog(`Failed: ${item.tweetId}_${item.mediaIndex} — ${e.message}`);
      }
      pendingMedia.shift();
      runtime.mediaDone++;
      // Light state checkpoint every item (throttled inside persist()).
      if (runtime.mediaDone % 5 === 0) {
        recomputeSummary();
        persist();
      }
      // Heavy pending-list write only every 25 items, plus manifest checkpoint.
      if (runtime.mediaDone % 25 === 0 || pendingMedia.length === 0) {
        await savePending();
        await saveManifest(manifest);
      }
    }
    recomputeSummary();
    await savePending();
    await saveManifest(manifest);
    await writeIndexFiles(folder, manifest);

    runtime.totalKnown = Object.keys(manifest.bookmarks).length;
    runtime.finishedAt = new Date().toISOString();
    runtime.currentPhase = null;
    if (cancelFlag) {
      // If cancel left items unprocessed, we're back to "ready" so user can resume.
      runtime.status = pendingMedia.length ? "ready" : "cancelled";
      appendLog(`Cancelled during download. ${pendingMedia.length} still pending.`);
    } else {
      runtime.status = "done";
      appendLog(`Download done. ${runtime.mediaDone} processed, ${runtime.mediaErrored} errored, total=${runtime.totalKnown}.`);
    }
    await persistNow();
  } catch (e) {
    runtime.status = "error";
    runtime.errorMessage = e.message;
    runtime.finishedAt = new Date().toISOString();
    runtime.currentPhase = null;
    appendLog(`Error: ${e.message}`);
    await persistNow();
  }
}

async function writeIndexFiles(folder, manifest) {
  const allBookmarks = Object.values(manifest.bookmarks).sort((a, b) =>
    String(b.id).localeCompare(String(a.id))
  );
  const indexJsonUrl =
    "data:application/json;charset=utf-8," +
    encodeURIComponent(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          count: allBookmarks.length,
          lastRun: manifest.lastRun,
          bookmarks: allBookmarks
        },
        null,
        2
      )
    );
  await downloadFile(indexJsonUrl, `${folder}/index.json`, "overwrite");

  const txtLines = allBookmarks.map((t) =>
    [
      `URL:    ${t.url}`,
      `User:   @${t.username} (${t.displayName || ""})`,
      `Date:   ${t.createdAt || ""}`,
      `Text:   ${(t.text || "").replace(/\n/g, "\n        ")}`,
      t.media && t.media.length ? `Media:  ${t.media.length} item(s) (${t.media.filter((m) => m.downloaded).length} on disk)` : "",
      "----"
    ]
      .filter(Boolean)
      .join("\n")
  );
  const indexTxtUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(txtLines.join("\n\n"));
  await downloadFile(indexTxtUrl, `${folder}/index.txt`, "overwrite");

  const explorerHtml = buildExplorerHtml(allBookmarks, manifest);
  const explorerUrl = "data:text/html;charset=utf-8," + encodeURIComponent(explorerHtml);
  await downloadFile(explorerUrl, `${folder}/explorer.html`, "overwrite");
}

function buildExplorerHtml(bookmarks, manifest) {
  // Strip down each bookmark to the fields the UI needs, and embed inline.
  const slim = bookmarks.map((b) => ({
    id: b.id,
    url: b.url,
    username: b.username,
    displayName: b.displayName,
    createdAt: b.createdAt,
    text: b.text,
    replyCount: b.replyCount,
    retweetCount: b.retweetCount,
    favoriteCount: b.favoriteCount,
    quoteCount: b.quoteCount,
    lastSeenAt: b.lastSeenAt,
    lastSeenIndex: b.lastSeenIndex,
    media: (b.media || []).map((m) => ({
      kind: m.kind,
      index: m.index,
      url: m.url,
      downloaded: !!m.downloaded
    }))
  }));
  // Embedding JSON inside <script>: must escape `</script` and stay valid JSON.
  const json = JSON.stringify(slim).replace(/<\/script/gi, "<\\/script");
  const lastRun = manifest.lastRun ? new Date(manifest.lastRun.finishedAt).toLocaleString() : "never";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X Bookmarks (${slim.length})</title>
<style>
* { box-sizing: border-box; }
:root {
  --bg: #15202b;
  --fg: #e7e9ea;
  --muted: #8b98a5;
  --accent: #1d9bf0;
  --card: #1e2732;
  --card-hover: #232f3d;
  --border: #38444d;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --fg: #0f1419;
    --muted: #536471;
    --card: #f7f9f9;
    --card-hover: #eff3f4;
    --border: #eff3f4;
  }
}
html, body { margin: 0; }
body {
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  padding: 6px 12px;
}
.header-inner {
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
h1 {
  font-size: 13px;
  margin: 0;
  font-weight: 600;
  white-space: nowrap;
}
.meta {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
  white-space: nowrap;
}
.count { font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 4px; }
.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  align-items: center;
  justify-content: flex-end;
}
input, select, button {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  outline: none;
  height: 28px;
}
input:focus, select:focus { border-color: var(--accent); }
#search { flex: 1; min-width: 140px; max-width: 260px; }
main {
  max-width: 700px;
  margin: 0 auto;
  padding: 14px 16px 80px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--muted);
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 14px 16px;
  transition: background 0.12s;
  content-visibility: auto;
  contain-intrinsic-size: 0 220px;
}
.card:hover { background: var(--card-hover); }
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}
.user { font-size: 14px; }
.user .display { font-weight: 700; }
.user .handle { color: var(--muted); margin-left: 4px; }
.user a { color: inherit; text-decoration: none; }
.user a:hover .display { text-decoration: underline; }
.date {
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
  white-space: nowrap;
}
.date:hover { color: var(--accent); }
.text {
  font-size: 15px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 4px 0 6px;
}
.text a { color: var(--accent); text-decoration: none; }
.text a:hover { text-decoration: underline; }
.stats {
  font-size: 12px;
  color: var(--muted);
  margin-top: 8px;
  display: flex;
  gap: 14px;
}
.media {
  margin-top: 10px;
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.media a, .media .video-wrap { display: block; }
.media img, .media video {
  width: 100%;
  height: auto;
  max-height: 600px;
  object-fit: cover;
  border-radius: 12px;
  display: block;
  background: var(--border);
}
.missing {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  border-radius: 12px;
  background: var(--border);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  padding: 8px;
}
button#loadMore {
  display: block;
  align-self: center;
  justify-self: center;
  margin: 20px auto 40px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  cursor: pointer;
  padding: 0 22px;
  height: 38px;
  font-size: 13px;
  line-height: 38px;
  white-space: nowrap;
  text-align: center;
}
button#loadMore:hover { filter: brightness(1.08); }
/* In grid view, span the full row so it centers cleanly. */
main.view-grid #loadMore { grid-column: 1 / -1; }

/* View-mode toggle */
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  padding: 0;
  height: 28px;
}
.view-btn {
  border: none;
  background: var(--card);
  color: var(--muted);
  padding: 0 12px;
  cursor: pointer;
  border-radius: 0;
  font-size: 12px;
  height: 26px;
}
.view-btn.active { background: var(--accent); color: #fff; }
.view-btn:not(.active):hover { background: var(--card-hover); }

/* Grid view: a packed grid of media tiles */
main.view-grid {
  max-width: 1280px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 4px;
  padding: 12px;
}
main.view-grid .tile {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--border);
  overflow: hidden;
  border-radius: 6px;
  cursor: zoom-in;
  contain: paint;
}
main.view-grid .tile img,
main.view-grid .tile video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.18s ease;
}
main.view-grid .tile:hover img,
main.view-grid .tile:hover video { transform: scale(1.04); }
main.view-grid .tile .overlay {
  position: absolute;
  inset: auto 0 0 0;
  padding: 4px 6px;
  font-size: 11px;
  color: #fff;
  background: linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  transition: opacity 0.15s ease;
}
main.view-grid .tile:hover .overlay { opacity: 1; }
main.view-grid .tile.video::after {
  content: "▶";
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  padding: 2px 6px;
  border-radius: 6px;
}
main.view-grid .tile.missing {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--muted);
  cursor: default;
}

/* Lightbox */
#lightbox {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.92);
  z-index: 100;
  align-items: center;
  justify-content: center;
  display: none;
}
#lightbox.open { display: flex; }
#lbContent {
  max-width: 95vw;
  max-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
#lbContent img,
#lbContent video {
  max-width: 95vw;
  max-height: 90vh;
  object-fit: contain;
  display: block;
}
#lightbox > button {
  position: absolute;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 24px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  line-height: 1;
  z-index: 2;
}
#lbClose { top: 14px; right: 14px; }
#lbToggleInfo { top: 14px; right: 64px; font-size: 16px; font-style: italic; font-weight: 600; }
#lbPrev  { left: 14px; top: 50%; transform: translateY(-50%); }
#lbNext  { right: 14px; top: 50%; transform: translateY(-50%); }

/* Tweet info panel inside lightbox */
#lbInfo {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 40vh;
  background: linear-gradient(to top, rgba(0,0,0,0.96) 0%, rgba(0,0,0,0.78) 70%, rgba(0,0,0,0) 100%);
  color: #fff;
  padding: 40px 24px 18px;
  overflow-y: auto;
  transform: translateY(0);
  transition: transform 0.18s ease, opacity 0.18s ease;
  opacity: 1;
}
#lightbox.info-hidden #lbInfo {
  transform: translateY(100%);
  opacity: 0;
  pointer-events: none;
}
#lbInfoHeader {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 13px;
}
#lbUser { color: #fff; text-decoration: none; font-weight: 700; }
#lbUser:hover { text-decoration: underline; }
#lbDate { color: rgba(255,255,255,0.65); text-decoration: none; font-size: 12px; }
#lbDate:hover { color: var(--accent); }
#lbText {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-bottom: 8px;
}
#lbText a { color: var(--accent); text-decoration: none; }
#lbText a:hover { text-decoration: underline; }
#lbStats {
  font-size: 11px;
  color: rgba(255,255,255,0.55);
  display: flex;
  gap: 14px;
}
</style>
</head>
<body>
<header>
  <div class="header-inner">
    <h1>Bookmarks<span class="count" id="count">${slim.length}</span></h1>
    <span class="meta" title="${escapeHtmlServer(lastRun)}"><a href="index.json" style="color:var(--accent)">json</a> &middot; <a href="index.txt" style="color:var(--accent)">txt</a></span>
    <div class="filters">
      <input id="search" type="search" placeholder="Search…" autofocus />
      <select id="userFilter"><option value="">All users</option></select>
      <select id="mediaFilter">
        <option value="">All</option>
        <option value="any">With media</option>
        <option value="photo">Photos</option>
        <option value="video">Videos</option>
        <option value="none">Text only</option>
      </select>
      <select id="sortBy">
        <option value="bookmarked-desc">Newest bookmarked</option>
        <option value="bookmarked-asc">Oldest bookmarked</option>
        <option value="created-desc">Newest tweet</option>
        <option value="created-asc">Oldest tweet</option>
        <option value="user">By user</option>
        <option value="likes">Most liked</option>
      </select>
      <div class="view-toggle" role="tablist" aria-label="View mode">
        <button id="viewList" class="view-btn active" data-view="list">List</button>
        <button id="viewGrid" class="view-btn" data-view="grid">Grid</button>
      </div>
    </div>
  </div>
</header>
<main id="grid" class="view-list"></main>

<!-- Lightbox for grid view -->
<div id="lightbox" aria-hidden="true">
  <button id="lbClose" aria-label="close">&times;</button>
  <button id="lbPrev" aria-label="previous">&lsaquo;</button>
  <button id="lbNext" aria-label="next">&rsaquo;</button>
  <button id="lbToggleInfo" aria-label="toggle info" title="Show/hide tweet text (i)">i</button>
  <div id="lbContent"></div>
  <aside id="lbInfo">
    <div id="lbInfoHeader">
      <a id="lbUser" href="#" target="_blank" rel="noopener"></a>
      <a id="lbDate" href="#" target="_blank" rel="noopener"></a>
    </div>
    <div id="lbText"></div>
    <div id="lbStats"></div>
  </aside>
</div>
<script id="bookmarks-data" type="application/json">${json}</script>
<script>
(function(){
  const data = JSON.parse(document.getElementById('bookmarks-data').textContent);
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const userFilter = document.getElementById('userFilter');
  const mediaFilter = document.getElementById('mediaFilter');
  const sortBy = document.getElementById('sortBy');
  const countEl = document.getElementById('count');

  // Populate user dropdown sorted by frequency.
  const userCounts = {};
  for (const b of data) userCounts[b.username] = (userCounts[b.username] || 0) + 1;
  const users = Object.entries(userCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [u, c] of users) {
    const o = document.createElement('option');
    o.value = u;
    o.textContent = '@' + u + ' (' + c + ')';
    userFilter.appendChild(o);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function linkify(text) {
    let s = escapeHtml(text);
    s = s.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|[\\s>])@([a-zA-Z0-9_]{1,15})/g, '$1<a href="https://x.com/$2" target="_blank" rel="noopener">@$2</a>');
    s = s.replace(/(^|[\\s>])#([a-zA-Z0-9_]+)/g, '$1<a href="https://x.com/hashtag/$2" target="_blank" rel="noopener">#$2</a>');
    return s.replace(/\\n/g, '<br>');
  }
  function sanitizeUser(s) {
    return String(s || 'unknown').replace(/[^a-zA-Z0-9_\\-]/g, '_').slice(0, 60) || 'unknown';
  }
  function extFromUrl(u) {
    try {
      const url = new URL(u);
      const fmt = url.searchParams.get('format');
      if (fmt) return fmt;
      const m = url.pathname.match(/\\.([a-z0-9]+)(?:$|\\?)/i);
      return m ? m[1] : null;
    } catch { return null; }
  }
  function fmtNum(n) {
    if (n == null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\\.0$/, '') + 'K';
    return String(n);
  }
  function fmtDate(s) {
    try {
      const d = new Date(s);
      if (isNaN(d)) return s || '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return s || ''; }
  }

  let filtered = [];
  let renderedCount = 0;
  const PAGE_SIZE = 50;
  const GRID_PAGE_SIZE = 200;
  let viewMode = 'list'; // 'list' | 'grid'

  // Flat list of {bookmark, media} pairs, rebuilt when filters/sort change.
  let mediaList = [];

  function applyFilters() {
    const q = search.value.toLowerCase().trim().replace(/^@/, '');
    const u = userFilter.value;
    const mf = mediaFilter.value;
    const sb = sortBy.value;

    filtered = data.filter(b => {
      if (u && b.username !== u) return false;
      const hasMedia = b.media && b.media.length > 0;
      const hasPhoto = hasMedia && b.media.some(m => m.kind !== 'video');
      const hasVideo = hasMedia && b.media.some(m => m.kind === 'video');
      if (mf === 'photo' && !hasPhoto) return false;
      if (mf === 'video' && !hasVideo) return false;
      if (mf === 'any' && !hasMedia) return false;
      if (mf === 'none' && hasMedia) return false;
      if (q) {
        const blob = ((b.text || '') + ' ' + (b.username || '') + ' ' + (b.displayName || '')).toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });

    function bookmarkedKey(x) {
      // (lastSeenAt, lastSeenIndex) — re-stamped on every sync visit.
      // Older manifests fall back to firstSeenAt or tweet-id.
      const t = x.lastSeenAt ? Date.parse(x.lastSeenAt) || 0 : 0;
      const idx = x.lastSeenIndex != null ? x.lastSeenIndex : 1e9;
      return [t, idx, String(x.id)];
    }
    filtered.sort((a, b) => {
      switch (sb) {
        case 'bookmarked-asc': {
          // Oldest sync first; within sync, highest index first (oldest in batch).
          const ka = bookmarkedKey(a), kb = bookmarkedKey(b);
          return (ka[0] - kb[0]) || (kb[1] - ka[1]) || ka[2].localeCompare(kb[2]);
        }
        case 'bookmarked-desc': {
          // Newest sync first; within sync, lowest index first (newest in batch).
          const ka = bookmarkedKey(a), kb = bookmarkedKey(b);
          return (kb[0] - ka[0]) || (ka[1] - kb[1]) || kb[2].localeCompare(ka[2]);
        }
        case 'created-desc':   return new Date(b.createdAt) - new Date(a.createdAt);
        case 'created-asc':    return new Date(a.createdAt) - new Date(b.createdAt);
        case 'user':           return (a.username || '').localeCompare(b.username || '');
        case 'likes':          return (b.favoriteCount || 0) - (a.favoriteCount || 0);
        default:               return 0;
      }
    });

    // Rebuild flat media list (used by Grid view).
    mediaList = [];
    for (const b of filtered) {
      if (!b.media || !b.media.length) continue;
      for (const m of b.media) mediaList.push({ b: b, m: m });
    }

    if (viewMode === 'grid') {
      countEl.textContent = mediaList.length === 0
        ? '0 media'
        : (mediaList.length + ' media · ' + filtered.length + ' tweets' + (filtered.length === data.length ? '' : (' / ' + data.length)));
    } else {
      countEl.textContent = filtered.length === data.length
        ? data.length
        : (filtered.length + ' / ' + data.length);
    }

    grid.innerHTML = '';
    renderedCount = 0;
    grid.classList.toggle('view-grid', viewMode === 'grid');
    grid.classList.toggle('view-list', viewMode === 'list');

    const items = viewMode === 'grid' ? mediaList : filtered;
    if (items.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = viewMode === 'grid' ? 'No media matches.' : 'Nothing matches.';
      grid.appendChild(e);
      return;
    }
    renderMore();
  }

  function renderMore() {
    const items = viewMode === 'grid' ? mediaList : filtered;
    const pageSize = viewMode === 'grid' ? GRID_PAGE_SIZE : PAGE_SIZE;
    const end = Math.min(renderedCount + pageSize, items.length);
    const frag = document.createDocumentFragment();
    for (let i = renderedCount; i < end; i++) {
      frag.appendChild(viewMode === 'grid' ? buildTile(items[i], i) : buildCard(items[i]));
    }
    const oldBtn = document.getElementById('loadMore');
    if (oldBtn) oldBtn.remove();
    grid.appendChild(frag);
    renderedCount = end;
    if (renderedCount < items.length) {
      const btn = document.createElement('button');
      btn.id = 'loadMore';
      btn.textContent = 'Load more (' + (items.length - renderedCount) + ' remaining)';
      btn.onclick = renderMore;
      grid.appendChild(btn);
    }
  }

  function buildTile(item, mediaIdx) {
    const { b, m } = item;
    const tile = document.createElement('div');
    tile.className = 'tile' + (m.kind === 'video' ? ' video' : '');
    tile.dataset.mediaIdx = String(mediaIdx);
    const safeUser = sanitizeUser(b.username);
    const ext = m.kind === 'video' ? 'mp4' : (extFromUrl(m.url) || 'jpg');
    const localPath = 'media/' + safeUser + '/' + b.id + '_' + m.index + '.' + ext;

    if (m.kind === 'video') {
      const v = document.createElement('video');
      v.src = localPath;
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.onerror = () => {
        tile.classList.add('missing');
        tile.innerHTML = '<span>Video missing</span>';
      };
      tile.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = localPath;
      img.loading = 'lazy';
      img.alt = '';
      img.onerror = () => {
        if (img.dataset.fallbackTried) {
          tile.classList.add('missing');
          tile.innerHTML = '<span>Image missing</span>';
        } else {
          img.dataset.fallbackTried = '1';
          img.src = m.url;
        }
      };
      tile.appendChild(img);
    }

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.textContent = '@' + b.username;
    tile.appendChild(overlay);

    tile.addEventListener('click', () => openLightbox(mediaIdx));
    return tile;
  }

  // ---- Lightbox ----
  const lightbox = document.getElementById('lightbox');
  const lbContent = document.getElementById('lbContent');
  const lbUser = document.getElementById('lbUser');
  const lbDate = document.getElementById('lbDate');
  const lbText = document.getElementById('lbText');
  const lbStats = document.getElementById('lbStats');
  let lbIndex = -1;

  function openLightbox(idx) {
    lbIndex = idx;
    showLightbox();
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  }
  function closeLightbox() {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
    lbContent.innerHTML = '';
    lbText.innerHTML = '';
    lbIndex = -1;
  }
  function isLightboxOpen() { return lightbox.classList.contains('open'); }
  function showLightbox() {
    if (lbIndex < 0 || lbIndex >= mediaList.length) return;
    const { b, m } = mediaList[lbIndex];
    lbContent.innerHTML = '';
    const safeUser = sanitizeUser(b.username);
    const ext = m.kind === 'video' ? 'mp4' : (extFromUrl(m.url) || 'jpg');
    const localPath = 'media/' + safeUser + '/' + b.id + '_' + m.index + '.' + ext;
    let el;
    if (m.kind === 'video') {
      el = document.createElement('video');
      el.src = localPath;
      el.controls = true;
      el.autoplay = true;
      el.playsInline = true;
    } else {
      el = document.createElement('img');
      el.src = localPath;
      el.alt = '';
      el.onerror = () => {
        if (el.dataset.fallbackTried) return;
        el.dataset.fallbackTried = '1';
        el.src = m.url;
      };
    }
    lbContent.appendChild(el);

    // Populate the info panel.
    lbUser.href = 'https://x.com/' + encodeURIComponent(b.username);
    lbUser.innerHTML = escapeHtml(b.displayName || '') + ' <span style="color:rgba(255,255,255,0.55);font-weight:400">@' + escapeHtml(b.username) + '</span>';
    lbDate.href = b.url;
    lbDate.textContent = fmtDate(b.createdAt) + ' · open tweet →';
    lbText.innerHTML = b.text ? linkify(b.text) : '<em style="color:rgba(255,255,255,0.4)">(no text)</em>';
    lbStats.innerHTML =
      '<span>&#x1F4AC; ' + fmtNum(b.replyCount) + '</span>' +
      '<span>&#x1F501; ' + fmtNum(b.retweetCount) + '</span>' +
      '<span>&#x2764; ' + fmtNum(b.favoriteCount) + '</span>' +
      '<span>&#x1F4AC; ' + fmtNum(b.quoteCount) + '</span>';
  }

  // Persist info-panel preference across lightbox opens within this session.
  let infoHidden = false;
  function applyInfoVisibility() {
    lightbox.classList.toggle('info-hidden', infoHidden);
  }
  document.getElementById('lbToggleInfo').addEventListener('click', (e) => {
    e.stopPropagation();
    infoHidden = !infoHidden;
    applyInfoVisibility();
  });
  document.getElementById('lbClose').addEventListener('click', closeLightbox);
  document.getElementById('lbPrev').addEventListener('click', (e) => {
    e.stopPropagation();
    if (lbIndex > 0) { lbIndex--; showLightbox(); }
  });
  document.getElementById('lbNext').addEventListener('click', (e) => {
    e.stopPropagation();
    if (lbIndex < mediaList.length - 1) { lbIndex++; showLightbox(); }
  });
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!isLightboxOpen()) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft' && lbIndex > 0) { lbIndex--; showLightbox(); }
    else if (e.key === 'ArrowRight' && lbIndex < mediaList.length - 1) { lbIndex++; showLightbox(); }
    else if (e.key === 'i' || e.key === 'I') { infoHidden = !infoHidden; applyInfoVisibility(); }
  });

  // ---- View mode toggle ----
  document.getElementById('viewList').addEventListener('click', () => setView('list'));
  document.getElementById('viewGrid').addEventListener('click', () => setView('grid'));
  function setView(v) {
    if (viewMode === v) return;
    viewMode = v;
    document.getElementById('viewList').classList.toggle('active', v === 'list');
    document.getElementById('viewGrid').classList.toggle('active', v === 'grid');
    applyFilters();
  }

  function buildCard(b) {
    const card = document.createElement('article');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';

    const userDiv = document.createElement('div');
    userDiv.className = 'user';
    const userLink = document.createElement('a');
    userLink.href = 'https://x.com/' + encodeURIComponent(b.username);
    userLink.target = '_blank';
    userLink.rel = 'noopener';
    userLink.innerHTML = '<span class="display">' + escapeHtml(b.displayName || '') + '</span><span class="handle">@' + escapeHtml(b.username) + '</span>';
    userDiv.appendChild(userLink);
    header.appendChild(userDiv);

    const dateLink = document.createElement('a');
    dateLink.href = b.url;
    dateLink.target = '_blank';
    dateLink.rel = 'noopener';
    dateLink.className = 'date';
    dateLink.textContent = fmtDate(b.createdAt);
    header.appendChild(dateLink);

    card.appendChild(header);

    if (b.text) {
      const t = document.createElement('div');
      t.className = 'text';
      t.innerHTML = linkify(b.text);
      card.appendChild(t);
    }

    if (b.media && b.media.length) {
      const mediaDiv = document.createElement('div');
      mediaDiv.className = 'media';
      const safeUser = sanitizeUser(b.username);
      for (const m of b.media) {
        const ext = m.kind === 'video' ? 'mp4' : (extFromUrl(m.url) || 'jpg');
        const localPath = 'media/' + safeUser + '/' + b.id + '_' + m.index + '.' + ext;
        if (m.kind === 'video') {
          const wrap = document.createElement('div');
          wrap.className = 'video-wrap';
          const v = document.createElement('video');
          v.src = localPath;
          v.controls = true;
          v.preload = 'metadata';
          v.playsInline = true;
          v.onerror = () => {
            wrap.innerHTML = '';
            const miss = document.createElement('div');
            miss.className = 'missing';
            miss.textContent = 'Video not on disk — open original tweet';
            wrap.appendChild(miss);
          };
          wrap.appendChild(v);
          mediaDiv.appendChild(wrap);
        } else {
          const a = document.createElement('a');
          a.href = localPath;
          a.target = '_blank';
          const img = document.createElement('img');
          img.src = localPath;
          img.loading = 'lazy';
          img.alt = '';
          img.onerror = () => {
            // fall back to remote URL if local missing
            if (img.dataset.fallbackTried) {
              const miss = document.createElement('div');
              miss.className = 'missing';
              miss.textContent = 'Image not available';
              a.replaceWith(miss);
            } else {
              img.dataset.fallbackTried = '1';
              img.src = m.url;
            }
          };
          a.appendChild(img);
          mediaDiv.appendChild(a);
        }
      }
      card.appendChild(mediaDiv);
    }

    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML =
      '<span>&#x1F4AC; ' + fmtNum(b.replyCount) + '</span>' +
      '<span>&#x1F501; ' + fmtNum(b.retweetCount) + '</span>' +
      '<span>&#x2764; ' + fmtNum(b.favoriteCount) + '</span>' +
      '<span>&#x1F4AC; ' + fmtNum(b.quoteCount) + '</span>';
    card.appendChild(stats);

    return card;
  }

  search.addEventListener('input', applyFilters);
  userFilter.addEventListener('change', applyFilters);
  mediaFilter.addEventListener('change', applyFilters);
  sortBy.addEventListener('change', applyFilters);

  applyFilters();
})();
</script>
</body>
</html>`;
}

function escapeHtmlServer(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function auditAgainstChromeDownloads(manifest) {
  const pending = [];
  for (const id of Object.keys(manifest.bookmarks)) {
    const t = manifest.bookmarks[id];
    if (!t.media) continue;
    for (const m of t.media) {
      if (!m.downloaded && m.url) pending.push({ tweetId: id, mediaIndex: m.index, url: m.url });
    }
  }
  if (!pending.length) return 0;
  appendLog(`Auditing ${pending.length} URLs…`);
  await persist();
  let reconciled = 0;
  const results = await mapLimited(
    pending,
    4, // concurrency cap — Chrome's download manager chokes if we go higher
    (p) => cancelFlag ? false : existsByUrl(p.url),
    (done, total) => { appendLog(`Audit progress: ${done}/${total}`); persist(); }
  );
  for (let i = 0; i < pending.length; i++) {
    if (results[i]) {
      const t = manifest.bookmarks[pending[i].tweetId];
      const m = t && t.media && t.media.find((mm) => mm.index === pending[i].mediaIndex);
      if (m) { m.downloaded = true; reconciled++; }
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
            version: XBD_SW_VERSION,
            state: runtime,
            captured: {
              hasAuth: !!(captured.auth && captured.auth.authorization && captured.auth.csrf),
              queryId: captured.queryId,
              operation: captured.operation
            }
          });
          return;
        }
        case "startSync": {
          if (runtime.status === "syncing" || runtime.status === "downloading" || runtime.status === "cancelling") {
            sendResponse({ ok: false, error: "Already running" });
            return;
          }
          runSync(msg.options || {}); // fire-and-forget
          sendResponse({ ok: true });
          return;
        }
        case "startDownload": {
          if (runtime.status !== "ready") {
            sendResponse({ ok: false, error: `Cannot start download from status "${runtime.status}".` });
            return;
          }
          runDownload();
          sendResponse({ ok: true });
          return;
        }
        case "discardPending": {
          await clearPending();
          recomputeSummary();
          runtime.status = "idle";
          appendLog("Pending list discarded.");
          await persistNow();
          sendResponse({ ok: true });
          return;
        }
        case "cancelBackup": {
          if (runtime.status === "syncing" || runtime.status === "downloading" || runtime.status === "cancelling") {
            cancelFlag = true;
            runtime.status = "cancelling";
            appendLog("Cancel requested.");
            await persist();
            await cancelAllDownloads();
          }
          sendResponse({ ok: true });
          return;
        }
        case "clearManifest": {
          await chrome.storage.local.remove(MANIFEST_KEY);
          sendResponse({ ok: true });
          return;
        }
        case "getManifest": {
          const m = await loadManifest();
          sendResponse({ ok: true, manifest: m });
          return;
        }
        case "resetState": {
          runtime = freshState();
          await persistNow();
          sendResponse({ ok: true });
          return;
        }
        case "wipeAll": {
          // Emergency: clears every storage key the extension owns. Captured auth/queryId
          // is also cleared, so the user must reopen x.com/i/bookmarks afterwards.
          await chrome.storage.local.clear();
          await chrome.storage.session.clear().catch(() => {});
          runtime = freshState();
          pendingMedia = [];
          captured = { auth: null, queryId: null, operation: null };
          appendLog("All extension data wiped.");
          await persistNow();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});

// === STARTUP ===
loadPersisted();
chrome.runtime.onStartup.addListener(loadPersisted);
chrome.runtime.onInstalled.addListener(loadPersisted);
