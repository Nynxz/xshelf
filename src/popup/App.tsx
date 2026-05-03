import { useEffect, useState } from "preact/hooks";
import { send, SW_VERSION } from "../lib/messaging";
import type { Manifest, RuntimeState, CapturedSummary, SourceKey } from "../lib/types";
import { userSource } from "../lib/types";

type SourceMode = "bookmarks" | "user";

export function App() {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [captured, setCaptured] = useState<CapturedSummary | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [folder, setFolder] = useState("xshelf");
  const [maxPages, setMaxPages] = useState(200);
  const [incremental, setIncremental] = useState(true);
  const [sourceMode, setSourceMode] = useState<SourceMode>("bookmarks");
  const [userHandle, setUserHandle] = useState("");
  const [userArchiveMode, setUserArchiveMode] = useState<"media" | "tweets">("media");
  const [detectedHandle, setDetectedHandle] = useState<string | null>(null);

  // Auto-detect a handle from the active tab if it's an x.com/<handle> profile.
  // Reserved paths (i, home, search, etc.) are excluded; only valid handle
  // shapes /^[A-Za-z0-9_]{1,15}$/ count.
  useEffect(() => {
    const RESERVED = new Set([
      "i", "home", "explore", "notifications", "messages", "compose",
      "settings", "search", "hashtag", "events", "topics", "lists",
      "communities", "tos", "privacy", "premium_sign_up", "logout",
    ]);
    let cancelled = false;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (cancelled || !tab?.url) return;
      try {
        const u = new URL(tab.url);
        if (!/^(x|twitter)\.com$/i.test(u.hostname)) return;
        const seg = u.pathname.split("/").filter(Boolean)[0];
        if (!seg) return;
        if (RESERVED.has(seg)) return;
        if (!/^[A-Za-z0-9_]{1,15}$/.test(seg)) return;
        setDetectedHandle(seg);
      } catch {
        /* ignore */
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Find the most recent on-disk explorer.html snapshot and open it. Uses
  // chrome.downloads.open which respects the user's click as a "gesture" and
  // launches the file in the default app (the browser, for HTML).
  async function openSnapshot() {
    try {
      const items = await chrome.downloads.search({
        filenameRegex: ".*explorer\\.html$",
        state: "complete",
        limit: 1,
        orderBy: ["-startTime"],
      });
      if (items.length === 0) {
        alert("No snapshot yet — run a sync first.");
        return;
      }
      try {
        chrome.downloads.open(items[0].id);
      } catch {
        // chrome.downloads.open requires a user gesture and may fail; fall back
        // to revealing the file in the system file manager.
        chrome.downloads.show(items[0].id);
      }
    } catch (e) {
      alert("Couldn't open snapshot: " + ((e as Error).message ?? String(e)));
    }
  }

  async function refresh() {
    try {
      const r = await send({ type: "getRunState" });
      if (r.ok) {
        setState(r.state);
        setCaptured(r.captured);
        setVersion(r.version);
      }
      // Show stats for whatever source the user is about to sync — bookmarks
      // by default, the @handle's archive when in user-archive mode.
      const target = computedSource ?? "bookmarks";
      const m = await send({ type: "getManifest", source: target });
      if (m.ok) setManifest(m.manifest);
    } catch {
      // service worker isn't reachable
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    const onMessage = (msg: any) => {
      if (msg?.type === "stateUpdate" && msg.state) setState(msg.state as RuntimeState);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      clearInterval(interval);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  // Re-fetch the manifest stats when the active source changes so the popup
  // shows the right history count (bookmarks vs @handle's archive).
  useEffect(() => {
    refresh();
  }, [sourceMode, userHandle, detectedHandle]);

  const status = state?.status ?? "idle";
  const versionMismatch = version != null && version !== SW_VERSION;

  // If the user hasn't typed a handle, fall back to the auto-detected one
  // from the active tab (so being on https://x.com/elonmusk → archive @elonmusk
  // with no typing).
  const effectiveHandle = userHandle.trim() || detectedHandle || "";

  function buildSource(): SourceKey | null {
    if (sourceMode === "bookmarks") return "bookmarks";
    const h = effectiveHandle.replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(h)) return null;
    return userSource(h);
  }

  const computedSource = buildSource();
  const userOpReady =
    userArchiveMode === "media"
      ? !!captured?.hasUserMedia
      : !!captured?.hasUserTweets;
  const canStartSync =
    !!computedSource &&
    !!captured?.hasAuth &&
    (sourceMode === "bookmarks"
      ? !!captured.hasBookmarks
      : !!captured.hasUserByScreenName && userOpReady);

  return (
    <>
      <h1>X Bookmark Downloader</h1>

      {versionMismatch && (
        <div class="status warn">
          Service worker on stale code ({version}, expected {SW_VERSION}).
          Toggle the extension off+on at chrome://extensions.
        </div>
      )}

      <CaptureLine captured={captured} />

      <SourcePicker
        mode={sourceMode} setMode={setSourceMode}
        handle={userHandle} setHandle={setUserHandle}
        detectedHandle={detectedHandle}
        userArchiveMode={userArchiveMode} setUserArchiveMode={setUserArchiveMode}
        disabled={status === "syncing" || status === "downloading" || status === "cancelling"}
      />
      <RunOptions
        folder={folder} setFolder={setFolder}
        maxPages={maxPages} setMaxPages={setMaxPages}
        incremental={incremental} setIncremental={setIncremental}
        disabled={status === "syncing" || status === "downloading" || status === "cancelling"}
      />

      <ManifestStats manifest={manifest} />
      <RunStatus state={state} />

      {state && status === "ready" && state.pendingSummary.count > 0 && (
        <ReviewPanel summary={state.pendingSummary} />
      )}

      <ActionBar
        status={status}
        onStartSync={() => {
          if (!computedSource) {
            alert("Enter a valid @handle (1–15 letters/digits/underscores).");
            return;
          }
          return send({
            type: "startSync",
            options: {
              source: computedSource,
              folder,
              maxPages,
              incremental,
              userMode: sourceMode === "user" ? userArchiveMode : undefined,
            },
          });
        }}
        canStartSync={canStartSync}
        onStartDownload={() => send({ type: "startDownload" })}
        onCancel={() => send({ type: "cancelBackup" })}
        onDiscard={async () => {
          if (!confirm("Discard the pending list?")) return;
          await send({ type: "discardPending" });
        }}
        onReset={async () => {
          // Wipe just the manifest of whatever source the user has selected.
          // Files on disk aren't deleted; the next sync's audit will reconcile
          // anything that's still present.
          const target = computedSource ?? "bookmarks";
          const label =
            target === "bookmarks" ? "your bookmarks history" : `the @${effectiveHandle} archive`;
          if (!confirm(`Reset ${label}?\nFiles on disk are not deleted.`)) return;
          await send({ type: "clearManifest", source: target });
          refresh();
        }}
        onWipe={async () => {
          if (!confirm("WIPE ALL EXTENSION DATA?\nFiles on disk are NOT deleted.")) return;
          await send({ type: "wipeAll" });
          refresh();
        }}
        onOpenExplorer={openSnapshot}
      />

      <div class="status hint">
        <strong>How it works:</strong> <em>Sync</em> reads X's bookmarks API and reconciles
        with your manifest. Click <em>Download</em> to fetch new media or <em>Discard</em> to skip.
        The run lives in the service worker — close and reopen this popup any time.
        <br /><br />
        After each sync, a self-contained <code>{(folder || "xshelf") + "/bookmarks/explorer.html"}</code> is written
        to your Downloads folder. Open that file from your file manager for full media browsing.
        The "Open explorer" button below opens the live in-browser version (faster, but local
        videos won't play there).
        <br /><br />
        Open <a href="#" onClick={(e) => { e.preventDefault(); chrome.tabs.create({ url: "https://x.com/i/bookmarks" }); }}>x.com/i/bookmarks</a>
        {" "}first so the extension can capture your session.
      </div>

      {state && state.log.length > 0 && (
        <pre id="log">{state.log.join("\n")}</pre>
      )}
    </>
  );
}

function CaptureLine({ captured }: { captured: CapturedSummary | null }) {
  if (!captured) return <div class="status">Capture: …</div>;
  const okBookmarks = captured.hasAuth && captured.hasBookmarks;
  const okUsersMedia = captured.hasAuth && captured.hasUserByScreenName && captured.hasUserMedia;
  const okUsersTweets = captured.hasAuth && captured.hasUserByScreenName && captured.hasUserTweets;
  if (okBookmarks && okUsersMedia && okUsersTweets) {
    return <div class="status">Capture OK (bookmarks ✓, user-archive ✓)</div>;
  }
  const parts: string[] = [];
  if (!captured.hasAuth) parts.push("auth (visit x.com)");
  if (!captured.hasBookmarks) parts.push("bookmarks (visit x.com/i/bookmarks)");
  if (!captured.hasUserByScreenName) parts.push("UserByScreenName (visit any profile)");
  if (!captured.hasUserMedia) parts.push("UserMedia (visit a profile's Media tab)");
  if (!captured.hasUserTweets) parts.push("UserTweets (scroll a profile)");
  return (
    <div class="status warn">
      Capture missing: {parts.join("; ")}.
    </div>
  );
}

function RunOptions({
  folder, setFolder, maxPages, setMaxPages, incremental, setIncremental, disabled,
}: {
  folder: string; setFolder: (v: string) => void;
  maxPages: number; setMaxPages: (v: number) => void;
  incremental: boolean; setIncremental: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div class="row">
        <label for="folder">Folder name (inside Downloads/)</label>
        <input
          id="folder" type="text" value={folder}
          onInput={(e) => setFolder((e.target as HTMLInputElement).value)}
          disabled={disabled}
        />
      </div>
      <div class="row">
        <label for="maxPages">Max pages (×100 bookmarks)</label>
        <input
          id="maxPages" type="number" min={1} max={500} value={maxPages}
          onInput={(e) => setMaxPages(parseInt((e.target as HTMLInputElement).value, 10) || 200)}
          disabled={disabled}
        />
      </div>
      <div class="row checkbox">
        <input id="incremental" type="checkbox" checked={incremental}
          onChange={(e) => setIncremental((e.target as HTMLInputElement).checked)}
          disabled={disabled}
        />
        <label for="incremental">Incremental: skip known bookmarks, stop early when known</label>
      </div>
    </>
  );
}

function SourcePicker({
  mode, setMode, handle, setHandle, detectedHandle,
  userArchiveMode, setUserArchiveMode, disabled,
}: {
  mode: SourceMode;
  setMode: (m: SourceMode) => void;
  handle: string;
  setHandle: (h: string) => void;
  detectedHandle: string | null;
  userArchiveMode: "media" | "tweets";
  setUserArchiveMode: (m: "media" | "tweets") => void;
  disabled: boolean;
}) {
  return (
    <>
      <div class="row">
        <label for="source-mode">Source</label>
        <select
          id="source-mode" value={mode}
          onChange={(e) => setMode((e.target as HTMLSelectElement).value as SourceMode)}
          disabled={disabled}
        >
          <option value="bookmarks">My bookmarks</option>
          <option value="user">Archive a user{detectedHandle ? ` (@${detectedHandle})` : ""}</option>
        </select>
      </div>
      {mode === "user" && (
        <>
          <div class="row">
            <label for="user-handle">
              @handle{detectedHandle ? ` — leave blank to use @${detectedHandle}` : " (no leading @)"}
            </label>
            <input
              id="user-handle" type="text"
              placeholder={detectedHandle ?? "elonmusk"}
              value={handle}
              onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
              disabled={disabled}
              spellcheck={false}
              autocapitalize="off"
            />
          </div>
          <div class="row checkbox">
            <input
              id="include-text"
              type="checkbox"
              checked={userArchiveMode === "tweets"}
              onChange={(e) =>
                setUserArchiveMode((e.target as HTMLInputElement).checked ? "tweets" : "media")
              }
              disabled={disabled}
            />
            <label for="include-text">
              Include text-only posts (slower; uses UserTweets instead of UserMedia)
            </label>
          </div>
        </>
      )}
    </>
  );
}

function ManifestStats({ manifest }: { manifest: Manifest | null }) {
  if (!manifest || Object.keys(manifest.bookmarks).length === 0) {
    return <div class="status">History: empty.</div>;
  }
  const count = Object.keys(manifest.bookmarks).length;
  const last = manifest.lastRun ? new Date(manifest.lastRun.finishedAt).toLocaleString() : "never";
  return <div class="status">History: {count} bookmarks tracked. Last run: {last}.</div>;
}

function RunStatus({ state }: { state: RuntimeState | null }) {
  if (!state) return <div class="status">Run: idle.</div>;
  let label: string;
  switch (state.status) {
    case "syncing": label = `Syncing — ${state.currentPhase ?? "…"}`; break;
    case "ready": label = `Ready: ${state.pendingSummary.count} media items pending review.`; break;
    case "downloading": label = "Downloading…"; break;
    case "cancelling": label = "Cancelling…"; break;
    case "cancelled": label = "Cancelled."; break;
    case "done": label = "Done."; break;
    case "error": label = `Error: ${state.errorMessage ?? "?"}`; break;
    case "interrupted": label = `Interrupted (${state.errorMessage ?? "service worker restart"})`; break;
    default: label = "Idle.";
  }
  if (state.status === "syncing" && state.totalSeen) {
    label += ` — ${state.totalSeen} seen, ${state.newCount} new across ${state.pageCount} page(s)`;
  } else if (state.status === "downloading" && state.mediaTotal) {
    label += ` — ${state.mediaDone}/${state.mediaTotal}`;
  }
  const showProgress = state.status === "downloading" && state.mediaTotal > 0;
  const pct = showProgress ? Math.min(100, Math.round((state.mediaDone / state.mediaTotal) * 100)) : 0;
  return (
    <>
      <div class={`status ${state.status === "error" || state.status === "interrupted" ? "warn" : ""}`}>{label}</div>
      {showProgress && (
        <div class="progress"><div class="bar" style={{ width: `${pct}%` }} /></div>
      )}
    </>
  );
}

function ReviewPanel({ summary }: { summary: RuntimeState["pendingSummary"] }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const lines = Object.entries(summary.byUser)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([user, info]) => `@${user.padEnd(20)} ${String(info.count).padStart(4)}  (${info.photos}p ${info.videos}v)`);
  return (
    <div class="review">
      <div class="review-header">
        <strong>{summary.tweetCount} tweets · {summary.count} media ({summary.photoCount} photos, {summary.videoCount} videos)</strong>
        <button class="link-btn" onClick={() => setShowBreakdown((v) => !v)}>
          {showBreakdown ? "hide breakdown" : "show breakdown"}
        </button>
      </div>
      {showBreakdown && <pre>{lines.join("\n")}</pre>}
    </div>
  );
}

function ActionBar(props: {
  status: RuntimeState["status"];
  onStartSync: () => void;
  canStartSync?: boolean;
  onStartDownload: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onReset: () => void;
  onWipe: () => void;
  onOpenExplorer: () => void;
}) {
  const busy = props.status === "syncing" || props.status === "downloading" || props.status === "cancelling";
  const ready = props.status === "ready";
  const canStart = props.canStartSync !== false;
  return (
    <div class="actions">
      {!ready && (
        <button
          class="primary"
          disabled={busy || !canStart}
          title={canStart ? undefined : "Capture missing or invalid handle — see status above"}
          onClick={props.onStartSync}
        >
          Start sync
        </button>
      )}
      {ready && <button class="primary" onClick={props.onStartDownload}>Download all</button>}
      {ready && <button onClick={props.onDiscard}>Discard pending</button>}
      <button disabled={!busy} onClick={props.onCancel}>Cancel</button>
      <button onClick={props.onOpenExplorer}>Open explorer</button>
      <button disabled={busy} onClick={props.onReset}>Reset history</button>
      <button class="danger" disabled={busy} onClick={props.onWipe}>Wipe all</button>
    </div>
  );
}
