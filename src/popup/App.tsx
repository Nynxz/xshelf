import { useEffect, useMemo, useState } from "preact/hooks";
import { send, SW_VERSION } from "../lib/messaging";
import type {
  RuntimeState,
  CapturedSummary,
  SourceKey,
  UnbookmarkOptions,
  UnbookmarkReport,
  VerifyReport,
} from "../lib/types";
import { userSource, isUserSource, sourceUsername } from "../lib/types";

type TabKey = "run" | "sources" | "cleanup" | "settings" | "help";

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
          state={state}
          status={status}
          folder={folder}
          maxPages={maxPages}
          incremental={incremental}
          refreshKey={state?.startedAt ?? state?.finishedAt ?? null}
          onRefresh={refresh}
          switchToRun={() => setTab("run")}
        />
      )}

      {tab === "cleanup" && (
        <CleanupTab
          captured={captured}
          state={state}
          status={status}
          folder={folder}
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
    { key: "cleanup", label: "Cleanup" },
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
            disabled={!detected || !captureOk || status === "syncing" || status === "downloading" || status === "cancelling" || status === "verifying"}
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
    case "verifying": label = `Verifying — ${state.currentPhase ?? "…"}`; break;
    case "unbookmarking": label = `Unbookmarking — ${state.currentPhase ?? "…"} ${state.mediaTotal ? `(${state.mediaDone}/${state.mediaTotal})` : ""}`; break;
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
  captured, state, status, folder, maxPages, incremental, refreshKey, onRefresh, switchToRun,
}: {
  captured: CapturedSummary | null;
  state: RuntimeState | null;
  status: RuntimeState["status"];
  folder: string;
  maxPages: number;
  incremental: boolean;
  refreshKey: string | null;
  onRefresh: () => void;
  switchToRun: () => void;
}) {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [newHandle, setNewHandle] = useState("");
  const [verifying, setVerifying] = useState<SourceKey | null>(null);
  // Per-source verify report. Keyed by SourceKey so switching between rows
  // doesn't clobber a prior report.
  const [reports, setReports] = useState<Record<string, VerifyReport>>({});
  const [importMsg, setImportMsg] = useState<string | null>(null);

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

  const busy = status === "syncing" || status === "downloading" || status === "cancelling" || status === "verifying";

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

  async function verifyNow(source: SourceKey) {
    setVerifying(source);
    try {
      const res = await send({ type: "verifySource", source, folder, dryRun: true });
      if (!res.ok) {
        alert("Verify failed: " + (res.error ?? "unknown"));
        return;
      }
      setReports((prev) => ({ ...prev, [source]: res.report }));
    } finally {
      setVerifying(null);
    }
  }

  async function queueMissing(source: SourceKey) {
    setVerifying(source);
    try {
      const res = await send({ type: "verifySource", source, folder, dryRun: false });
      if (!res.ok) {
        alert("Could not queue missing items: " + (res.error ?? "unknown"));
        return;
      }
      setReports((prev) => {
        const next = { ...prev };
        delete next[source];
        return next;
      });
      onRefresh();
      switchToRun();
    } finally {
      setVerifying(null);
    }
  }

  function dismissReport(source: SourceKey) {
    setReports((prev) => {
      const next = { ...prev };
      delete next[source];
      return next;
    });
  }

  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-selecting same file later
    if (!file) return;
    setImportMsg("Reading file…");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        schema?: string;
        source?: SourceKey;
        items?: Array<{
          tweetId: string;
          username: string;
          mediaIndex: number;
          kind: "photo" | "video";
          url: string;
        }>;
      };
      if (parsed.schema !== "xshelf-missing-list/1") {
        setImportMsg("⚠ Not a recognised xshelf missing-list file.");
        return;
      }
      if (!parsed.source || !Array.isArray(parsed.items)) {
        setImportMsg("⚠ File is missing source or items.");
        return;
      }
      if (parsed.items.length === 0) {
        setImportMsg("File has no missing items — nothing to queue.");
        return;
      }
      const res = await send({
        type: "importMissingList",
        source: parsed.source,
        folder,
        items: parsed.items,
      });
      if (!res.ok) {
        setImportMsg("⚠ Import failed: " + (res.error ?? "unknown"));
        return;
      }
      // Keep the message visible — do NOT auto-switch tabs. If the popup was
      // closed during the file picker, the auto-switch races against re-open
      // and the user lands on Sources with no signal anything happened.
      setImportMsg(
        `✓ Queued ${res.queued} item${res.queued === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} skipped)` : ""} for download.`,
      );
      onRefresh();
    } catch (err) {
      setImportMsg("⚠ Could not read file: " + ((err as Error).message ?? String(err)));
    }
  }

  const pendingCount = state?.pendingSummary.count ?? 0;
  const hasPending = status === "ready" && pendingCount > 0;

  return (
    <>
      {hasPending && (
        <div class="banner ok pending-banner">
          <div class="banner-title">
            <strong>{pendingCount} item{pendingCount === 1 ? "" : "s"} pending download</strong>
          </div>
          <div class="banner-body">
            Switch to the <strong>Run</strong> tab and click <em>Download all</em> to fetch them.
          </div>
          <div style={{ marginTop: "6px" }}>
            <button class="primary" onClick={switchToRun}>Go to Run →</button>
          </div>
        </div>
      )}

      <div class="import-row">
        <label class="import-btn" title="Pick a missing-list JSON exported from the explorer's Find missing media">
          <input
            type="file"
            accept="application/json,.json"
            onChange={onImportFile}
            disabled={busy}
          />
          <span>Import missing list…</span>
        </label>
        {importMsg && (
          <div class="status hint import-msg">
            <span>{importMsg}</span>
            <button class="link-btn" onClick={() => setImportMsg(null)}>dismiss</button>
          </div>
        )}
      </div>

      <div class="sources-list">
        {rows.length === 0 ? (
          <div class="status">No sources synced yet. Use the <strong>Run</strong> tab to start.</div>
        ) : rows.map((r) => (
          <div key={r.key}>
            <div class="source-row">
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
                <button
                  disabled={busy || r.count === 0}
                  onClick={() => verifyNow(r.key)}
                  title={r.count === 0 ? "No items to verify" : "Dry-run check: which media is missing on disk?"}
                >
                  {verifying === r.key ? "Verifying…" : "Verify"}
                </button>
                <button class="danger" disabled={busy} onClick={() => reset(r.key)}>Reset</button>
              </div>
            </div>
            {reports[r.key] && (
              <VerifyReportCard
                report={reports[r.key]}
                busy={busy}
                working={verifying === r.key}
                onQueue={() => queueMissing(r.key)}
                onDismiss={() => dismissReport(r.key)}
              />
            )}
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

function VerifyReportCard({
  report, busy, working, onQueue, onDismiss,
}: {
  report: VerifyReport;
  busy: boolean;
  working: boolean;
  onQueue: () => void;
  onDismiss: () => void;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const allGood = report.missingCount === 0;
  const breakdown = Object.entries(report.byUser)
    .sort((a, b) => b[1].missing - a[1].missing)
    .map(
      ([user, info]) =>
        `@${user.padEnd(20)} ${String(info.missing).padStart(4)}  (${info.photos}p ${info.videos}v)`,
    );
  return (
    <div class="verify-report" data-status={allGood ? "ok" : "warn"}>
      <div class="verify-report-header">
        <strong>
          {allGood
            ? `All ${report.totalMedia} media item${report.totalMedia === 1 ? "" : "s"} present on disk.`
            : `${report.missingCount} of ${report.totalMedia} media missing on disk.`}
        </strong>
        <button class="link-btn" onClick={onDismiss}>dismiss</button>
      </div>
      {report.reconcilableCount > 0 && (
        <div class="verify-report-sub">
          {report.reconcilableCount} item{report.reconcilableCount === 1 ? " was" : "s were"} on disk
          but not tracked — these will be reconciled if you proceed.
        </div>
      )}
      {!allGood && breakdown.length > 0 && (
        <>
          <button class="link-btn" onClick={() => setShowBreakdown((v) => !v)}>
            {showBreakdown ? "hide breakdown" : "show breakdown"}
          </button>
          {showBreakdown && <pre>{breakdown.join("\n")}</pre>}
        </>
      )}
      {!allGood && (
        <div class="verify-report-actions">
          <button
            class="primary"
            disabled={busy && !working}
            onClick={onQueue}
            title="Flips manifest flags + queues missing items into the pending list. Use 'Download all' on the Run tab next."
          >
            {working ? "Queuing…" : `Queue ${report.missingCount} for download`}
          </button>
        </div>
      )}
      <div class="verify-report-hint">
        Read-only metadata check. Reports what Chrome's download history says about the
        expected file paths — no filesystem crawl.
      </div>
    </div>
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
  const busy = status === "syncing" || status === "downloading" || status === "cancelling" || status === "verifying";
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

// ---- Cleanup tab -----------------------------------------------------------

const ORDER_LABELS: Record<UnbookmarkOptions["order"], string> = {
  "newest-bookmarked-first": "Newest bookmarked first (fast)",
  "oldest-bookmarked-first": "Oldest bookmarked first (full scan)",
  "newest-tweet-first": "Newest tweet first (full scan)",
  "oldest-tweet-first": "Oldest tweet first (full scan)",
};

function CleanupTab({
  captured, state, status, folder, onRefresh,
}: {
  captured: CapturedSummary | null;
  state: RuntimeState | null;
  status: RuntimeState["status"];
  folder: string;
  onRefresh: () => void;
}) {
  const [count, setCount] = useState(100);
  const [order, setOrder] = useState<UnbookmarkOptions["order"]>("newest-bookmarked-first");
  const [usernameFilter, setUsernameFilter] = useState("");
  const [preview, setPreview] = useState<UnbookmarkReport | null>(null);
  const [running, setRunning] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalBookmarks, setTotalBookmarks] = useState<number | null>(null);

  const busy = status === "syncing" || status === "downloading" || status === "cancelling" || status === "verifying" || status === "unbookmarking";

  // Load the bookmarks manifest just to show the user how many entries exist.
  useEffect(() => {
    let cancelled = false;
    send({ type: "getManifest", source: "bookmarks" }).then((r) => {
      if (cancelled || !r.ok) return;
      const all = Object.values(r.manifest.bookmarks);
      const active = all.filter((b) => !b.unbookmarkedAt).length;
      setTotalBookmarks(active);
    });
    return () => { cancelled = true; };
  }, [status]);

  function buildOptions(dryRun: boolean): UnbookmarkOptions {
    return {
      source: "bookmarks",
      order,
      usernameFilter: usernameFilter.trim().replace(/^@/, "") || undefined,
      count,
      dryRun,
    };
  }

  async function runPreview() {
    setError(null);
    setRunning(true);
    try {
      const res = await send({ type: "unbookmark", options: buildOptions(true), folder });
      if (!res.ok) {
        setError(res.error ?? "preview failed");
        setPreview(null);
        return;
      }
      setPreview(res.report);
    } finally {
      setRunning(false);
    }
  }

  async function runBackup() {
    setError(null);
    setBackupPath(null);
    const res = await send({ type: "backupManifest", folder });
    if (!res.ok) {
      setError(res.error ?? "backup failed");
      return;
    }
    setBackupPath(res.path);
  }

  async function runDelete() {
    if (!preview || preview.preview.length === 0) {
      setError("Run preview first.");
      return;
    }
    const n = preview.preview.length;
    const confirmation = prompt(
      `This will unbookmark ${n} item${n === 1 ? "" : "s"} from your X account.\n\n` +
        `Your LOCAL archive (media + metadata) is NOT modified — only the bookmark\n` +
        `on x.com is removed. A backup of your bookmarks manifest will be written\n` +
        `to <folder>/backups/ before any deletes.\n\n` +
        `Type DELETE to confirm:`,
    );
    if (confirmation !== "DELETE") {
      setError(confirmation == null ? null : "Did not type DELETE — nothing changed.");
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const res = await send({ type: "unbookmark", options: buildOptions(false), folder });
      if (!res.ok) {
        setError(res.error ?? "unbookmark failed");
        return;
      }
      setPreview(res.report);
      onRefresh();
    } finally {
      setRunning(false);
    }
  }

  const captureReady =
    !!captured?.hasAuth && !!captured?.hasBookmarks && !!captured?.hasDeleteBookmark;

  return (
    <>
      <div class="banner warn">
        <div class="banner-title">Cleanup unbookmarks from your X account.</div>
        <div class="banner-body">
          Walks your <strong>live x.com bookmarks list</strong> page-by-page (no
          dependency on the local manifest) so the preview always matches what's
          actually on your account. Your local archive (media + text + metadata)
          is <strong>never modified</strong>. A backup is written before any delete.
        </div>
      </div>

      <div class="status hint" style={{ marginTop: "6px" }}>
        Local archive size: <strong>{totalBookmarks ?? "…"}</strong> {" "}
        <span class="source-meta">(unchanged by cleanup — only x.com is touched)</span>
      </div>

      {!captureReady && (
        <div class="status warn" style={{ marginTop: "6px" }}>
          {captured?.hasAuth ? null : "Visit x.com so the extension can capture your session. "}
          {captured?.hasBookmarks ? null : "Scroll x.com/i/bookmarks once to capture the Bookmarks endpoint. "}
          {captured?.hasDeleteBookmark
            ? null
            : "Remove ONE bookmark manually on x.com/i/bookmarks so the DeleteBookmark queryId is captured."}
        </div>
      )}

      <div class="row" style={{ marginTop: "10px" }}>
        <label for="cleanup-order">Order</label>
        <select
          id="cleanup-order"
          value={order}
          disabled={running || busy}
          onChange={(e: Event) =>
            setOrder((e.target as HTMLSelectElement).value as UnbookmarkOptions["order"])
          }
        >
          {Object.entries(ORDER_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
      </div>

      <div class="row">
        <label for="cleanup-user">Only @username (optional)</label>
        <input
          id="cleanup-user"
          type="text"
          placeholder="elonmusk"
          value={usernameFilter}
          spellcheck={false}
          autocapitalize="off"
          disabled={running || busy}
          onInput={(e: Event) => setUsernameFilter((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="row">
        <label for="cleanup-count">Batch size (max 1000)</label>
        <input
          id="cleanup-count"
          type="number"
          min={1}
          max={1000}
          value={count}
          disabled={running || busy}
          onInput={(e: Event) =>
            setCount(Math.max(1, Math.min(1000, parseInt((e.target as HTMLInputElement).value, 10) || 100)))
          }
        />
      </div>

      <div class="actions">
        <button onClick={runBackup} disabled={running || busy}>
          Back up manifest
        </button>
        <button onClick={runPreview} disabled={running || busy} title="Crawl x.com to see what would be unbookmarked. May take a while for non-newest-first orders.">
          {running ? "Scanning…" : "Preview (live scan)"}
        </button>
        <button
          class="danger"
          disabled={running || busy || !preview || preview.preview.length === 0 || !captureReady}
          onClick={runDelete}
          title={captureReady ? "Unbookmark the previewed batch" : "Capture not ready"}
        >
          {running ? "Unbookmarking…" : "Unbookmark batch"}
        </button>
        {status === "unbookmarking" && (
          <button onClick={() => send({ type: "cancelBackup" })}>
            Cancel
          </button>
        )}
      </div>

      {status === "unbookmarking" && state && (
        <CleanupProgress state={state} />
      )}

      {backupPath && (
        <div class="status hint" style={{ marginTop: "6px" }}>
          Backup written to <code>{backupPath}</code>
        </div>
      )}

      {error && (
        <div class="status warn" style={{ marginTop: "6px" }}>{error}</div>
      )}

      {preview && (
        <div class="review" style={{ marginTop: "10px" }}>
          <div class="review-header">
            <strong>
              {preview.removed.length > 0 || preview.alreadyGone.length > 0 || preview.failed.length > 0
                ? `Run done — ${preview.removed.length} removed, ${preview.alreadyGone.length} already gone, ${preview.failed.length} failed.`
                : `Preview: ${preview.preview.length} candidate${preview.preview.length === 1 ? "" : "s"} (live from X).`}
            </strong>
            <span class="source-meta">
              Local archive: {preview.remainingAfter}
            </span>
          </div>
          {preview.failed.length > 0 && (
            <pre class="failure-list">
              {preview.failed
                .slice(0, 10)
                .map((f) => `× ${f.id}\n  ${f.error}`)
                .join("\n\n")}
              {preview.failed.length > 10 ? `\n\n…and ${preview.failed.length - 10} more` : ""}
            </pre>
          )}
          {preview.preview.length > 0 && preview.failed.length === 0 && (
            <pre>
              {preview.preview
                .slice(0, 20)
                .map(
                  (p) =>
                    `@${p.username.padEnd(20)} ${(p.text.replace(/\s+/g, " ").slice(0, 60))}`,
                )
                .join("\n")}
              {preview.preview.length > 20 ? `\n…and ${preview.preview.length - 20} more` : ""}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

function CleanupProgress({ state }: { state: RuntimeState }) {
  const phase = state.currentPhase ?? "working";
  let body: string;
  let pct: number | null = null;
  switch (phase) {
    case "scanning":
      body = `Scanning x.com bookmarks · page ${state.pageCount} · ${state.totalSeen} matching found so far`;
      break;
    case "backup":
      body = "Writing manifest backup…";
      break;
    case "deleting":
      body = `Unbookmarking · ${state.mediaDone} / ${state.mediaTotal}${state.mediaErrored ? ` (${state.mediaErrored} failed)` : ""}`;
      pct = state.mediaTotal > 0 ? Math.round((state.mediaDone / state.mediaTotal) * 100) : null;
      break;
    default:
      body = phase;
  }
  return (
    <div class="status hint" style={{ marginTop: "8px" }}>
      <div>{body}</div>
      {pct != null && (
        <div class="progress" style={{ marginTop: "4px" }}>
          <div class="bar" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
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

      <h3>Cleanup (unbookmark on X)</h3>
      <p>
        The <strong>Cleanup</strong> tab removes bookmarks from your X account in batches.
        Your local archive — media files, text, all metadata — is <strong>never modified</strong>.
        A JSON backup of the bookmarks manifest is written to
        <code>{folder || "xshelf"}/backups/</code> before any delete runs.
      </p>
      <ol>
        <li>Make sure you've synced recently so the local archive is current.</li>
        <li>On the Cleanup tab pick an order, optional @username filter, and batch size.</li>
        <li>Click <strong>Preview</strong> to see exactly which tweets will be unbookmarked.</li>
        <li>Click <strong>Unbookmark batch</strong> and type <code>DELETE</code> to confirm.</li>
      </ol>
      <p class="status hint">
        To capture the DeleteBookmark queryId you need to remove ONE bookmark manually on
        x.com first (any one). The extension picks the queryId up from that request.
      </p>

      <h3>Repair missing media</h3>
      <ol>
        <li>Open the explorer for the source you want to check.</li>
        <li>Click <strong>Find missing</strong> in the toolbar, then <strong>Scan</strong>. The browser
          tries to load every file from disk and lists the ones it couldn't open.</li>
        <li>Click <strong>Download list</strong> to save the missing-list JSON.</li>
        <li>Back here, in <strong>Sources</strong> → <strong>Import missing list…</strong>, pick that file.</li>
        <li>The pending queue is populated — switch to <strong>Run</strong> and click <strong>Download all</strong>.</li>
      </ol>

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
