import { useEffect, useMemo, useState } from "preact/hooks";
import { send, SW_VERSION } from "../lib/messaging";
import type { RuntimeState, CapturedSummary, SourceKey } from "../lib/types";
import { userSource, isUserSource, sourceUsername } from "../lib/types";

type TabKey = "run" | "sources" | "settings" | "help";

const RESERVED_PATHS = new Set([
  "i", "home", "explore", "notifications", "messages", "compose",
  "settings", "search", "hashtag", "events", "topics", "lists",
  "communities", "tos", "privacy", "premium_sign_up", "logout",
]);

interface DetectedTarget {
  source: SourceKey;
  /** "media" / "tweets" if on a user profile; undefined for bookmarks. */
  userMode?: "media" | "tweets";
  /** Human-readable description for the Run tab banner. */
  label: string;
}

/**
 * Inspect the active tab URL and decide what the user is most likely about
 * to sync. Bookmarks page → bookmarks. /<handle>/media → that user's media
 * archive. /<handle> root → that user's full archive (UserTweets). No match
 * means the user needs to navigate first.
 */
function detectFromUrl(url: string | undefined): DetectedTarget | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^(x|twitter)\.com$/i.test(u.hostname)) return null;

  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return null;

  // Bookmarks: x.com/i/bookmarks (any sub-path)
  if (segs[0] === "i" && segs[1] === "bookmarks") {
    return { source: "bookmarks", label: "your bookmarks" };
  }

  // User profile: x.com/<handle>(/media|/with_replies|/...)
  const handle = segs[0];
  if (RESERVED_PATHS.has(handle)) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (segs[1] === "media") {
    return { source: userSource(handle), userMode: "media", label: `@${handle}'s media` };
  }
  // Fallback: treat any other profile sub-tab as a hint for full-archive (UserTweets).
  return { source: userSource(handle), userMode: "tweets", label: `@${handle}'s posts` };
}

export function App() {
  const [tab, setTab] = useState<TabKey>("run");
  const [state, setState] = useState<RuntimeState | null>(null);
  const [captured, setCaptured] = useState<CapturedSummary | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [folder, setFolder] = useState("xshelf");
  const [maxPages, setMaxPages] = useState(200);
  const [incremental, setIncremental] = useState(true);
  const [detected, setDetected] = useState<DetectedTarget | null>(null);

  // Auto-detect what's on the active tab so the Run tab can offer a one-click sync.
  useEffect(() => {
    let cancelled = false;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      if (cancelled) return;
      setDetected(detectFromUrl(tabs[0]?.url));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function refresh() {
    try {
      const r = await send({ type: "getRunState" });
      if (r.ok) {
        setState(r.state);
        setCaptured(r.captured);
        setVersion(r.version);
      }
    } catch {
      // service worker not reachable
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

  const status = state?.status ?? "idle";
  const versionMismatch = version != null && version !== SW_VERSION;

  async function startSync(source: SourceKey, userMode?: "media" | "tweets") {
    const res = await send({
      type: "startSync",
      options: { source, folder, maxPages, incremental, userMode },
    });
    if (!res.ok) alert("Could not start sync: " + (res.error ?? "unknown"));
  }

  return (
    <>
      <header class="popup-header">
        <h1>xshelf</h1>
        <TabBar active={tab} onChange={setTab} />
      </header>

      {versionMismatch && (
        <div class="status warn">
          Service worker on stale code ({version}, expected {SW_VERSION}). Toggle the
          extension off+on at chrome://extensions.
        </div>
      )}

      {tab === "run" && (
        <RunTab
          state={state}
          status={status}
          captured={captured}
          detected={detected}
          startSync={startSync}
        />
      )}

      {tab === "sources" && (
        <SourcesTab
          captured={captured}
          status={status}
          folder={folder}
          maxPages={maxPages}
          incremental={incremental}
          refreshKey={state?.startedAt ?? state?.finishedAt ?? null}
          onRefresh={refresh}
        />
      )}

      {tab === "settings" && (
        <SettingsTab
          folder={folder} setFolder={setFolder}
          maxPages={maxPages} setMaxPages={setMaxPages}
          incremental={incremental} setIncremental={setIncremental}
          onRefresh={refresh}
          status={status}
        />
      )}

      {tab === "help" && <HelpTab folder={folder} />}
    </>
  );
}

// ---- TabBar ----------------------------------------------------------------

function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "run", label: "Run" },
    { key: "sources", label: "Sources" },
    { key: "settings", label: "Settings" },
    { key: "help", label: "Help" },
  ];
  return (
    <nav class="tab-bar" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          class={`tab ${active === t.key ? "active" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

// ---- Run tab ---------------------------------------------------------------

function RunTab({
  state, status, captured, detected, startSync,
}: {
  state: RuntimeState | null;
  status: RuntimeState["status"];
  captured: CapturedSummary | null;
  detected: DetectedTarget | null;
  startSync: (source: SourceKey, userMode?: "media" | "tweets") => Promise<void>;
}) {
  const captureOk = useMemo(() => isCaptureReadyFor(captured, detected), [captured, detected]);

  return (
    <>
      <DetectedBanner detected={detected} captureOk={captureOk} captured={captured} />

      <RunStatus state={state} />

      {state && status === "ready" && state.pendingSummary.count > 0 && (
        <ReviewPanel summary={state.pendingSummary} />
      )}

      <div class="actions">
        {status === "ready" ? (
          <>
            <button class="primary" onClick={() => send({ type: "startDownload" })}>
              Download all
            </button>
            <button onClick={async () => {
              if (!confirm("Discard the pending list?")) return;
              await send({ type: "discardPending" });
            }}>Discard</button>
          </>
        ) : (
          <button
            class="primary"
            disabled={!detected || !captureOk || status === "syncing" || status === "downloading" || status === "cancelling"}
            onClick={() => detected && startSync(detected.source, detected.userMode)}
            title={detected ? undefined : "Open x.com/i/bookmarks or a user profile and re-open this popup."}
          >
            Sync {detected ? detected.label : "…"}
          </button>
        )}
        <button
          disabled={!(status === "syncing" || status === "downloading" || status === "cancelling")}
          onClick={() => send({ type: "cancelBackup" })}
        >
          Cancel
        </button>
        <button onClick={openMaster}>Open explorer</button>
      </div>

      {state && state.log.length > 0 && (
        <pre id="log">{state.log.join("\n")}</pre>
      )}
    </>
  );
}

function DetectedBanner({
  detected, captureOk, captured,
}: {
  detected: DetectedTarget | null;
  captureOk: boolean;
  captured: CapturedSummary | null;
}) {
  if (!detected) {
    return (
      <div class="banner">
        <div class="banner-title">No source detected on this tab</div>
        <div class="banner-body">
          Open <a href="#" onClick={(e: MouseEvent) => { e.preventDefault(); chrome.tabs.create({ url: "https://x.com/i/bookmarks" }); }}>x.com/i/bookmarks</a>
          {" "}to back up your bookmarks, or any user's profile (e.g. <code>x.com/elonmusk/media</code>) to archive them, then re-open this popup.
        </div>
      </div>
    );
  }
  if (!captureOk) {
    return (
      <div class="banner warn">
        <div class="banner-title">Will sync: <strong>{detected.label}</strong></div>
        <div class="banner-body">
          {captureHelpFor(detected, captured)}
        </div>
      </div>
    );
  }
  return (
    <div class="banner ok">
      <div class="banner-title">Will sync: <strong>{detected.label}</strong></div>
    </div>
  );
}

function isCaptureReadyFor(c: CapturedSummary | null, d: DetectedTarget | null): boolean {
  if (!c?.hasAuth || !d) return false;
  if (d.source === "bookmarks") return c.hasBookmarks;
  if (!c.hasUserByScreenName) return false;
  return d.userMode === "tweets" ? c.hasUserTweets : c.hasUserMedia;
}

function captureHelpFor(d: DetectedTarget, c: CapturedSummary | null): string {
  if (!c?.hasAuth) return "Visit x.com (any page) so the extension can capture your session, then re-open this popup.";
  if (d.source === "bookmarks" && !c.hasBookmarks) return "Scroll x.com/i/bookmarks once so the Bookmarks endpoint is captured.";
  if (!c.hasUserByScreenName) return "Visit any X profile so the UserByScreenName endpoint is captured.";
  if (d.userMode === "tweets" && !c.hasUserTweets) return "Scroll the user's profile (the main timeline) so UserTweets is captured.";
  if (d.userMode === "media" && !c.hasUserMedia) return "Visit the user's Media tab so UserMedia is captured.";
  return "Capture incomplete.";
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
      {showProgress && (<div class="progress"><div class="bar" style={{ width: `${pct}%` }} /></div>)}
    </>
  );
}

function ReviewPanel({ summary }: { summary: RuntimeState["pendingSummary"] }) {
  const [open, setOpen] = useState(false);
  const lines = Object.entries(summary.byUser)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([user, info]) => `@${user.padEnd(20)} ${String(info.count).padStart(4)}  (${info.photos}p ${info.videos}v)`);
  return (
    <div class="review">
      <div class="review-header">
        <strong>{summary.tweetCount} tweets · {summary.count} media ({summary.photoCount} photos, {summary.videoCount} videos)</strong>
        <button class="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "hide breakdown" : "show breakdown"}
        </button>
      </div>
      {open && <pre>{lines.join("\n")}</pre>}
    </div>
  );
}

// ---- Sources tab -----------------------------------------------------------

interface SourceRow {
  key: SourceKey;
  count: number;
  lastRun: string | null;
}

function SourcesTab({
  captured, status, folder, maxPages, incremental, refreshKey, onRefresh,
}: {
  captured: CapturedSummary | null;
  status: RuntimeState["status"];
  folder: string;
  maxPages: number;
  incremental: boolean;
  refreshKey: string | null;
  onRefresh: () => void;
}) {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [newHandle, setNewHandle] = useState("");

  async function loadRows() {
    const list = await send({ type: "listSources" });
    if (!list.ok) return;
    const fetched: SourceRow[] = [];
    for (const key of list.sources) {
      const m = await send({ type: "getManifest", source: key });
      if (m.ok) {
        fetched.push({
          key,
          count: Object.keys(m.manifest.bookmarks).length,
          lastRun: m.manifest.lastRun?.finishedAt ?? null,
        });
      }
    }
    fetched.sort((a, b) => {
      if (a.key === "bookmarks") return -1;
      if (b.key === "bookmarks") return 1;
      return a.key.localeCompare(b.key);
    });
    setRows(fetched);
  }

  useEffect(() => { loadRows(); }, [refreshKey]);

  const busy = status === "syncing" || status === "downloading" || status === "cancelling";

  async function syncNow(source: SourceKey, userMode?: "media" | "tweets") {
    const res = await send({
      type: "startSync",
      options: { source, folder, maxPages, incremental, userMode },
    });
    if (!res.ok) alert("Could not start sync: " + (res.error ?? "unknown"));
  }
  async function reset(source: SourceKey) {
    const label = source === "bookmarks" ? "your bookmarks history" : `the @${sourceUsername(source)} archive`;
    if (!confirm(`Reset ${label}?\nFiles on disk are not deleted.`)) return;
    await send({ type: "clearManifest", source });
    onRefresh();
    loadRows();
  }

  return (
    <>
      <div class="sources-list">
        {rows.length === 0 ? (
          <div class="status">No sources synced yet. Use the <strong>Run</strong> tab to start.</div>
        ) : rows.map((r) => (
          <div class="source-row" key={r.key}>
            <div class="source-row-label">
              <strong>{r.key === "bookmarks" ? "Bookmarks" : `@${sourceUsername(r.key)}`}</strong>
              <span class="source-meta">
                {r.count} item{r.count === 1 ? "" : "s"} · {r.lastRun ? new Date(r.lastRun).toLocaleString() : "never"}
              </span>
            </div>
            <div class="source-row-actions">
              <button
                disabled={busy || !isCaptureReadyForKey(captured, r.key)}
                onClick={() => syncNow(r.key, isUserSource(r.key) ? "media" : undefined)}
                title={isCaptureReadyForKey(captured, r.key) ? undefined : "Capture incomplete; visit the relevant X page first."}
              >
                Sync
              </button>
              <button class="danger" disabled={busy} onClick={() => reset(r.key)}>Reset</button>
            </div>
          </div>
        ))}
      </div>

      <div class="row" style={{ marginTop: "10px" }}>
        <label for="new-handle">Archive a new user (or re-archive without navigating)</label>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            id="new-handle" type="text" placeholder="elonmusk" value={newHandle}
            onInput={(e: Event) => setNewHandle((e.target as HTMLInputElement).value)}
            spellcheck={false} autocapitalize="off" style={{ flex: 1 }}
          />
          <button
            class="primary"
            disabled={busy || !/^[A-Za-z0-9_]{1,15}$/.test(newHandle.trim().replace(/^@/, "")) || !captured?.hasAuth || !captured?.hasUserByScreenName || !captured?.hasUserMedia}
            onClick={() => {
              const h = newHandle.trim().replace(/^@/, "");
              if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return;
              syncNow(userSource(h), "media");
              setNewHandle("");
            }}
          >
            Archive
          </button>
        </div>
      </div>
    </>
  );
}

function isCaptureReadyForKey(c: CapturedSummary | null, key: SourceKey): boolean {
  if (!c?.hasAuth) return false;
  if (key === "bookmarks") return c.hasBookmarks;
  return c.hasUserByScreenName && (c.hasUserMedia || c.hasUserTweets);
}

// ---- Settings tab ----------------------------------------------------------

function SettingsTab({
  folder, setFolder, maxPages, setMaxPages, incremental, setIncremental, onRefresh, status,
}: {
  folder: string; setFolder: (v: string) => void;
  maxPages: number; setMaxPages: (v: number) => void;
  incremental: boolean; setIncremental: (v: boolean) => void;
  onRefresh: () => void;
  status: RuntimeState["status"];
}) {
  const busy = status === "syncing" || status === "downloading" || status === "cancelling";
  return (
    <>
      <div class="row">
        <label for="folder">Folder name (inside Downloads/)</label>
        <input id="folder" type="text" value={folder}
          onInput={(e: Event) => setFolder((e.target as HTMLInputElement).value)}
          disabled={busy} />
      </div>
      <div class="row">
        <label for="maxPages">Max pages per sync (×100 items)</label>
        <input id="maxPages" type="number" min={1} max={500} value={maxPages}
          onInput={(e: Event) => setMaxPages(parseInt((e.target as HTMLInputElement).value, 10) || 200)}
          disabled={busy} />
      </div>
      <div class="row checkbox">
        <input id="incremental" type="checkbox" checked={incremental}
          onChange={(e: Event) => setIncremental((e.target as HTMLInputElement).checked)}
          disabled={busy} />
        <label for="incremental">Incremental: skip known items, stop early when known</label>
      </div>
      <div class="actions" style={{ marginTop: "16px" }}>
        <button class="danger" disabled={busy} onClick={async () => {
          if (!confirm("WIPE ALL EXTENSION DATA?\nAll manifests, pending list, captured auth. Files on disk are NOT deleted.")) return;
          await send({ type: "wipeAll" });
          onRefresh();
        }}>
          Wipe all data
        </button>
      </div>
      <div class="status hint" style={{ marginTop: "10px" }}>
        Wipe is destructive: clears every source's manifest and the captured session.
        Useful if state gets stuck. Files in Downloads/ are untouched.
      </div>
    </>
  );
}

// ---- Help tab --------------------------------------------------------------

function HelpTab({ folder }: { folder: string }) {
  return (
    <div class="help">
      <p>
        <strong>xshelf</strong> backs up your X (Twitter) bookmarks and lets you archive
        other users' content to a single shared folder. Read-only — never modifies the
        bookmarks on your account.
      </p>

      <h3>How a sync works</h3>
      <ol>
        <li>Open the relevant X page (your bookmarks or any user's profile/media tab).</li>
        <li>Open this popup; the <strong>Run</strong> tab auto-detects what's on the active tab.</li>
        <li>Click sync. The extension catalogues tweets into a per-source manifest, no media downloaded yet.</li>
        <li>Review the pending list and click <strong>Download all</strong>. Files land at
          <code>{folder || "xshelf"}/media/&lt;author&gt;/&lt;tweet-id&gt;_&lt;n&gt;.&lt;ext&gt;</code>.</li>
        <li>Click <strong>Open explorer</strong> — opens the master <code>{folder || "xshelf"}/index.html</code>.</li>
      </ol>

      <h3>Disk layout</h3>
      <pre>{`${folder || "xshelf"}/
  index.html              ← master, all sources combined
  media/<author>/...      ← shared media tree (deduplicated)
  bookmarks/
    explorer.html         ← per-source viewer
    data.js               ← consumed by master
  users/<handle>/
    explorer.html
    data.js
    crawls/<iso>.json     ← per-crawl content hash for diffing`}</pre>

      <h3>Privacy</h3>
      <p>
        The exported HTML is strictly offline — no remote calls, no telemetry, no fonts
        from CDNs. Missing media shows a hyperlink to the original tweet (a click-through,
        not an automatic fetch).
      </p>

      <p class="status hint">
        SW version: {SW_VERSION} · <a
          href="#" onClick={(e: MouseEvent) => { e.preventDefault(); chrome.tabs.create({ url: "https://x.com/i/bookmarks" }); }}
        >Open x.com bookmarks</a>
      </p>
    </div>
  );
}

// ---- Open-explorer helper (shared by Run tab) ------------------------------

async function openMaster() {
  try {
    let items = await chrome.downloads.search({
      filenameRegex: ".*[\\\\/]index\\.html$",
      state: "complete", limit: 1, orderBy: ["-startTime"],
    });
    if (items.length === 0) {
      items = await chrome.downloads.search({
        filenameRegex: ".*explorer\\.html$",
        state: "complete", limit: 1, orderBy: ["-startTime"],
      });
    }
    if (items.length === 0) {
      alert("No explorer yet — run a sync first.");
      return;
    }
    try { chrome.downloads.open(items[0].id); }
    catch { chrome.downloads.show(items[0].id); }
  } catch (e) {
    alert("Couldn't open explorer: " + ((e as Error).message ?? String(e)));
  }
}
