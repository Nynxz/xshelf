import { useEffect, useState } from "preact/hooks";
import { send, SW_VERSION } from "../lib/messaging";
import type { Manifest, RuntimeState, CapturedSummary } from "../lib/types";

export function App() {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [captured, setCaptured] = useState<CapturedSummary | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [folder, setFolder] = useState("x-bookmarks");
  const [maxPages, setMaxPages] = useState(200);
  const [incremental, setIncremental] = useState(true);

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
      const m = await send({ type: "getManifest" });
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

  const status = state?.status ?? "idle";
  const versionMismatch = version != null && version !== SW_VERSION;

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
        onStartSync={() => send({ type: "startSync", options: { folder, maxPages, incremental } })}
        onStartDownload={() => send({ type: "startDownload" })}
        onCancel={() => send({ type: "cancelBackup" })}
        onDiscard={async () => {
          if (!confirm("Discard the pending list?")) return;
          await send({ type: "discardPending" });
        }}
        onReset={async () => {
          if (!confirm("Reset history? Files on disk are not deleted; the audit will reconcile them.")) return;
          await send({ type: "clearManifest" });
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
        After each sync, a self-contained <code>{(folder || "x-bookmarks") + "/explorer.html"}</code> is written
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
  if (captured.hasAuth && captured.queryId && captured.operation) {
    return <div class="status">Capture OK ({captured.operation}, queryId={captured.queryId.slice(0, 10)}…)</div>;
  }
  const missing: string[] = [];
  if (!captured.hasAuth) missing.push("auth");
  if (!captured.queryId) missing.push("queryId");
  if (!captured.operation) missing.push("operation");
  return (
    <div class="status warn">
      Capture missing: {missing.join(", ")}. Open x.com/i/bookmarks and scroll once.
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
  onStartDownload: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onReset: () => void;
  onWipe: () => void;
  onOpenExplorer: () => void;
}) {
  const busy = props.status === "syncing" || props.status === "downloading" || props.status === "cancelling";
  const ready = props.status === "ready";
  return (
    <div class="actions">
      {!ready && <button class="primary" disabled={busy} onClick={props.onStartSync}>Start sync</button>}
      {ready && <button class="primary" onClick={props.onStartDownload}>Download all</button>}
      {ready && <button onClick={props.onDiscard}>Discard pending</button>}
      <button disabled={!busy} onClick={props.onCancel}>Cancel</button>
      <button onClick={props.onOpenExplorer}>Open explorer</button>
      <button disabled={busy} onClick={props.onReset}>Reset history</button>
      <button class="danger" disabled={busy} onClick={props.onWipe}>Wipe all</button>
    </div>
  );
}
