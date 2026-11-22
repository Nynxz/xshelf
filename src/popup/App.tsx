import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import brandIcon from "../assets/icon.svg";
import { send, SW_VERSION } from "../lib/messaging";
import { absolutePathRegex, loadDownloadRoot } from "../lib/downloads";
import { clearVerifyReport, loadVerifyReports } from "../lib/storage";
import { IBookmark, IBookmarkMinus, IExternal, IGear, IHelp, ILayers, IRebuild, ISync, IUser } from "../shelf/icons";
import type {
  RuntimeState,
  CapturedSummary,
  SourceKey,
  UnbookmarkOptions,
  UnbookmarkReport,
  VerifyReport,
} from "../lib/types";
import type { MediaVariant } from "../lib/types";
import {
  DEFAULT_MEDIA_VARIANT,
  KNOWN_MEDIA_VARIANTS,
  userSource,
  isUserSource,
  mediaVariantFromFilter,
  mediaVariantLabel,
  mediaVariantPath,
  sortMediaVariants,
  sourceUsername,
} from "../lib/types";

type TabKey = "run" | "sources" | "cleanup" | "settings" | "help";

const RESERVED_PATHS = new Set([
  "i",
  "home",
  "explore",
  "notifications",
  "messages",
  "compose",
  "settings",
  "search",
  "hashtag",
  "events",
  "topics",
  "lists",
  "communities",
  "tos",
  "privacy",
  "premium_sign_up",
  "logout",
]);

interface DetectedTarget {
  source: SourceKey;
  /** "media" / "tweets" if on a user profile; undefined for bookmarks. */
  userMode?: "media" | "tweets";
  /**
   * Which of X's filtered media views the tab is on (`/media` vs
   * `/media?filter=photo`). Only set when userMode is "media".
   */
  mediaVariant?: MediaVariant;
  /** The @handle, when this is a user source. */
  handle?: string;
  /** Human-readable description for the Run tab banner. */
  label: string;
}

/**
 * Inspect the active tab URL and decide what the user is most likely about
 * to sync. Bookmarks page → bookmarks. /<handle>/media → that user's media
 * archive. /<handle> root → that user's full archive (UserTweets). No match
 * means the user needs to navigate first.
 *
 * X's Media tab is filtered as of 2026-08 (`/media` vs `/media?filter=photo`)
 * and each view is a separate timeline, so we also record *which* view the tab
 * is showing — that's the view whose request the extension can capture here.
 */
function detectFromUrl(url: string | undefined): DetectedTarget | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(x|twitter)\.com$/i.test(u.hostname)) return null;

  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return null;

  // Bookmarks: x.com/i/history (any sub-path)
  if (segs[0] === "i" && segs[1] === "history") {
    return { source: "bookmarks", label: "your bookmarks" };
  }

  // User profile: x.com/<handle>(/media|/with_replies|/...)
  const handle = segs[0];
  if (RESERVED_PATHS.has(handle)) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (segs[1] === "media") {
    const mediaVariant = mediaVariantFromFilter(u.searchParams.get("filter"));
    return {
      source: userSource(handle),
      userMode: "media",
      mediaVariant,
      handle,
      label: `@${handle}'s media`,
    };
  }
  // Fallback: treat any other profile sub-tab as a hint for full-archive (UserTweets).
  return {
    source: userSource(handle),
    userMode: "tweets",
    handle,
    label: `@${handle}'s posts`,
  };
}

export function App() {
  const [tab, setTab] = useState<TabKey>("run");
  const [state, setState] = useState<RuntimeState | null>(null);
  const [captured, setCaptured] = useState<CapturedSummary | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [folder, setFolder] = useState("xshelf");
  const [maxPages, setMaxPages] = useState(200);
  const [incremental, setIncremental] = useState(true);
  const [fullScan, setFullScan] = useState(false);
  const [detected, setDetected] = useState<DetectedTarget | null>(null);

  // Auto-detect what's on the active tab so the Run tab can offer a one-click sync.
  useEffect(() => {
    let cancelled = false;
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => {
        if (cancelled) return;
        setDetected(detectFromUrl(tabs[0]?.url));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
      if (msg?.type === "stateUpdate" && msg.state)
        setState(msg.state as RuntimeState);
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
      options: { source, folder, maxPages, incremental, fullScan, userMode },
    });
    if (!res.ok) alert("Could not start sync: " + (res.error ?? "unknown"));
  }

  return (
    <>
      <header class="popup-header">
        <span class="brand" title={version ? `xshelf · ${version}` : "xshelf"}>
          <BrandMark />
          <h1>xshelf</h1>
        </span>
        <button type="button" class="header-btn" onClick={() => openMaster(folder)}>
          <IExternal size={14} /> Open Explorer
        </button>
      </header>
      <TabBar active={tab} onChange={setTab} />

      {versionMismatch && (
        <div class="status warn">
          Service worker on stale code ({version}, expected {SW_VERSION}).
          Toggle the extension off+on at chrome://extensions.
        </div>
      )}

      {tab === "run" && (
        <RunTab
          state={state}
          status={status}
          captured={captured}
          detected={detected}
          startSync={startSync}
          fullScan={fullScan}
          setFullScan={setFullScan}
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
          fullScan={fullScan}
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
          folder={folder}
          setFolder={setFolder}
          maxPages={maxPages}
          setMaxPages={setMaxPages}
          incremental={incremental}
          setIncremental={setIncremental}
          onRefresh={refresh}
          status={status}
        />
      )}

      {tab === "help" && <HelpTab folder={folder} />}
    </>
  );
}

// ---- Explorer maintenance -------------------------------------------------

function RebuildExplorerButton({ folder, busy }: { folder: string; busy: boolean }) {
  const [rebuilding, setRebuilding] = useState(false);
  return (
    <button
      type="button"
      disabled={rebuilding || busy}
      title="Rebuild explorer: rewrite its pages from your saved data (no sync), then open it"
      onClick={async () => {
        setRebuilding(true);
        try {
          const res = await send({ type: "rebuildExplorer", folder });
          if (res.ok) await openMaster(folder);
          else alert("Couldn't rebuild explorer: " + res.error);
        } finally {
          setRebuilding(false);
        }
      }}
    >
      <span class={rebuilding ? "spin" : ""}>
        <IRebuild size={14} />
      </span>
      {rebuilding ? "Rebuilding…" : "Rebuild Explorer"}
    </button>
  );
}

// ---- Header mark ---------------------------------------------------------------

function BrandMark() {
  return <img class="brand-mark" width="22" height="22" src={brandIcon} alt="" />;
}

// ---- TabBar ----------------------------------------------------------------

function TabBar({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (k: TabKey) => void;
}) {
  const tabs: Array<{ key: TabKey; label: string; icon: preact.JSX.Element }> = [
    { key: "run", label: "Backup", icon: <ISync size={15} /> },
    { key: "sources", label: "Sources", icon: <ILayers size={15} /> },
    { key: "cleanup", label: "Cleanup", icon: <IBookmarkMinus size={15} /> },
    { key: "settings", label: "Settings", icon: <IGear size={15} /> },
    { key: "help", label: "Help", icon: <IHelp size={15} /> },
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
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

// ---- Run tab ---------------------------------------------------------------

function RunTab({
  state,
  status,
  captured,
  detected,
  startSync,
  fullScan,
  setFullScan,
}: {
  state: RuntimeState | null;
  status: RuntimeState["status"];
  captured: CapturedSummary | null;
  detected: DetectedTarget | null;
  startSync: (
    source: SourceKey,
    userMode?: "media" | "tweets",
  ) => Promise<void>;
  fullScan: boolean;
  setFullScan: (v: boolean) => void;
}) {
  const captureOk = useMemo(
    () => isCaptureReadyFor(captured, detected),
    [captured, detected],
  );
  const busyRun =
    status === "syncing" ||
    status === "downloading" ||
    status === "cancelling" ||
    status === "verifying" ||
    status === "unbookmarking";
  const awaitingReview = status === "ready";
  const canCancel = status === "syncing" || status === "downloading";

  return (
    <>
      <DetectedBanner detected={detected} captureOk={captureOk} captured={captured} />
      <div class="backup-state">
        {awaitingReview && state?.pendingSummary.count ? (
          <ReviewPanel summary={state.pendingSummary} />
        ) : (
          <RunStatus state={state} />
        )}
      </div>

      <div class="actions backup-actions">
        {awaitingReview ? (
          <>
            <button
              class="primary"
              onClick={() => send({ type: "startDownload" })}
            >
              Download all
            </button>
            <button
              onClick={async () => {
                if (!confirm("Discard the pending list?")) return;
                await send({ type: "discardPending" });
              }}
            >
              Discard
            </button>
          </>
        ) : busyRun ? (
          <button
            class="backup-cancel"
            disabled={!canCancel}
            onClick={() => send({ type: "cancelBackup" })}
          >
            {canCancel ? "Cancel backup" : status === "cancelling" ? "Cancelling…" : "Backup in progress"}
          </button>
        ) : (
          <button
            class="primary"
            disabled={!detected || !captureOk}
            onClick={() =>
              detected && startSync(detected.source, detected.userMode)
            }
            title={
              detected
                ? undefined
                : "Open x.com/i/history or a user profile and re-open this popup."
            }
          >
            {detected ? `Sync ${detected.label}` : "Start backup"}
          </button>
        )}
      </div>

      <details class="backup-disclosure">
        <summary>Scan options{fullScan ? " · Full scan on" : ""}</summary>
        <label class="backup-option">
          <input
            type="checkbox"
            checked={fullScan}
            disabled={busyRun || awaitingReview}
            onChange={(e) => setFullScan(e.currentTarget.checked)}
          />
          <span><strong>Full scan</strong> Continue past known posts to look for gaps further back in the timeline.</span>
        </label>
      </details>
      <ActivityLog entries={state?.log} />
    </>
  );
}

function ActivityLog({ entries }: { entries?: string[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }, [entries]);

  return (
    <details
      class="backup-disclosure"
      onToggle={(e) => {
        const list = listRef.current;
        if (e.currentTarget.open && list) {
          following.current = true;
          list.scrollTop = list.scrollHeight;
        }
      }}
    >
      <summary>Activity log</summary>
      <ul
        class="activity-log"
        ref={listRef}
        tabIndex={0}
        aria-label="Activity entries"
        onScroll={(e) => {
          const { scrollHeight, scrollTop, clientHeight } = e.currentTarget;
          following.current = scrollHeight - scrollTop - clientHeight < 16;
        }}
      >
        {entries?.length ? entries.map((entry, i) => {
          const time = /^\[([^\]]+)\]\s*/.exec(entry);
          return (
            <li key={i}>
              {time && <span class="activity-time">{time[1]}</span>}
              <span class="activity-message">{time ? entry.slice(time[0].length) : entry}</span>
            </li>
          );
        }) : <li class="activity-empty">No activity yet.</li>}
      </ul>
    </details>
  );
}

function DetectedBanner({
  detected,
  captureOk,
  captured,
}: {
  detected: DetectedTarget | null;
  captureOk: boolean;
  captured: CapturedSummary | null;
}) {
  if (!detected) {
    return (
      <div class="target target-none">
        <div class="target-head">
          <span class="target-icon" aria-hidden="true">
            <ISync size={16} />
          </span>
          <div class="target-text">
            <div class="target-title">Nothing to sync on this tab</div>
            <div class="target-sub">Open a page on X, then reopen this popup.</div>
          </div>
        </div>
        <div class="target-links">
          <button type="button" class="chip-link" onClick={() => chrome.tabs.create({ url: "https://x.com/i/history" })}>
            <IBookmark size={12} /> Your bookmarks
          </button>
          <span class="target-or">or any profile's Media / Posts tab</span>
        </div>
      </div>
    );
  }
  const coverage = mediaCoverageNote(detected, captured);
  const ready = captureOk && !coverage?.warn;
  const note = !captureOk ? captureHelpFor(detected, captured) : coverage?.text;
  return (
    <div class={`target ${captureOk ? (coverage?.warn ? "is-partial" : "is-ready") : "is-setup"}`}>
      <div class="target-head">
        <span class="target-icon" aria-hidden="true">
          {detected.source === "bookmarks" ? <IBookmark size={16} /> : <IUser size={16} />}
        </span>
        <div class="target-text">
          <div class="target-title">{detected.label}</div>
          {note && <div class="target-sub">{note}</div>}
        </div>
        <span class="target-badge">{ready ? "Ready" : captureOk ? "Partial" : "Needs setup"}</span>
      </div>
      {coverage && detected.handle && coverage.missing.length > 0 && (
        <MediaVariantLinks handle={detected.handle} variants={coverage.missing} />
      )}
    </div>
  );
}

/** One-click links to the media views whose request we still need to observe. */
function MediaVariantLinks({
  handle,
  variants,
}: {
  handle: string;
  variants: MediaVariant[];
}) {
  if (variants.length === 0) return null;
  return (
    <div class="target-links">
      {variants.map((v) => (
        <button
          type="button"
          key={v}
          class="chip-link"
          onClick={() => chrome.tabs.update({ url: `https://x.com${mediaVariantPath(handle, v)}` })}
        >
          Open {mediaVariantLabel(v)}
        </button>
      ))}
    </div>
  );
}

function isCaptureReadyFor(
  c: CapturedSummary | null,
  d: DetectedTarget | null,
): boolean {
  if (!c?.hasAuth || !d) return false;
  if (d.source === "bookmarks") return c.hasBookmarks;
  if (!c.hasUserByScreenName) return false;
  return d.userMode === "tweets" ? c.hasUserTweets : c.hasUserMedia;
}

/**
 * Views we tell the user to capture but haven't seen yet. Only the *known*
 * views are nagged about — any other filter X serves is captured and crawled
 * automatically when the user visits it.
 */
function missingMediaVariants(c: CapturedSummary | null): MediaVariant[] {
  const have = new Set(c?.userMediaVariants ?? []);
  return KNOWN_MEDIA_VARIANTS.filter((v) => !have.has(v));
}

function captureHelpFor(d: DetectedTarget, c: CapturedSummary | null): string {
  if (!c?.hasAuth)
    return "Visit x.com (any page) so the extension can capture your session, then re-open this popup.";
  if (d.source === "bookmarks" && !c.hasBookmarks)
    return "Scroll x.com/i/history once so the Bookmarks endpoint is captured.";
  if (!c.hasUserByScreenName)
    return "Visit any X profile so the UserByScreenName endpoint is captured.";
  if (d.userMode === "tweets" && !c.hasUserTweets)
    return "Scroll the user's profile (the main timeline) so UserTweets is captured.";
  if (d.userMode === "media" && !c.hasUserMedia)
    return "Scroll this Media tab once so the extension can capture its request.";
  return "Capture incomplete.";
}

/**
 * X serves a different timeline per media filter, so an archive is only
 * complete once every view has been captured. Tells the user what this sync
 * will cover, whether the view they're looking at is captured, and which views
 * to open next.
 */
function mediaCoverageNote(
  d: DetectedTarget,
  c: CapturedSummary | null,
): { text: string; missing: MediaVariant[]; warn: boolean } | null {
  if (d.userMode !== "media") return null;
  const captured = sortMediaVariants(c?.userMediaVariants ?? []);
  const current = d.mediaVariant ?? DEFAULT_MEDIA_VARIANT;
  const currentCaptured = captured.includes(current);
  // They're already on this view — scrolling it is the fix, not a link to it.
  const missing = missingMediaVariants(c).filter((v) => v !== current);

  if (!currentCaptured) {
    return {
      text:
        `Scroll this view (${mediaVariantLabel(current)}) once so its request is captured` +
        `${captured.length > 0 ? ` — so far only ${captured.map(mediaVariantLabel).join(" + ")} ${captured.length === 1 ? "is" : "are"} captured` : ""}.`,
      missing,
      warn: true,
    };
  }

  const coveredList = captured.map(mediaVariantLabel).join(" + ");
  if (missing.length === 0) {
    return {
      text: `Will crawl all captured media views (${coveredList}).`,
      missing,
      warn: false,
    };
  }
  return {
    text:
      `Will crawl ${coveredList}. X serves a separate timeline per media filter, ` +
      `so open and scroll the view${missing.length > 1 ? "s" : ""} below once to include ` +
      `${missing.map(mediaVariantLabel).join(" and ")} too.`,
    missing,
    warn: true,
  };
}

function RunStatus({ state }: { state: RuntimeState | null }) {
  if (!state || state.status === "idle") {
    return <div class="status run-status">No backup in progress</div>;
  }
  let label: string;
  switch (state.status) {
    case "syncing":
      label = `Syncing — ${state.currentPhase ?? "…"}`;
      break;
    case "verifying":
      label = `Verifying — ${state.currentPhase ?? "…"}`;
      break;
    case "unbookmarking":
      label = `Unbookmarking — ${state.currentPhase ?? "…"} ${state.mediaTotal ? `(${state.mediaDone}/${state.mediaTotal})` : ""}`;
      break;
    case "ready":
      label = `Ready: ${state.pendingSummary.count} media items pending review.`;
      break;
    case "downloading":
      label = "Downloading…";
      break;
    case "cancelling":
      label = "Cancelling…";
      break;
    case "cancelled":
      label = "Cancelled.";
      break;
    case "done":
      label = "Done.";
      break;
    case "error":
      label = `Error: ${state.errorMessage ?? "?"}`;
      break;
    case "interrupted":
      label = `Interrupted (${state.errorMessage ?? "service worker restart"})`;
      break;
    default:
      label = "Idle.";
  }
  if (state.status === "syncing" && state.totalSeen) {
    label += ` — ${state.totalSeen} seen, ${state.newCount} new across ${state.pageCount} page(s)`;
  } else if (state.status === "downloading" && state.mediaTotal) {
    label += ` — ${state.mediaDone}/${state.mediaTotal}`;
  }
  const showProgress = state.status === "downloading" && state.mediaTotal > 0;
  const pct = showProgress
    ? Math.min(100, Math.round((state.mediaDone / state.mediaTotal) * 100))
    : 0;
  return (
    <>
      <div
        class={`status run-status ${state.status === "error" || state.status === "interrupted" ? "warn" : ""}`}
        data-state={state.status}
        role="status"
      >
        {label}
      </div>
      {showProgress && (
        <div class="progress">
          <div class="bar" style={{ width: `${pct}%` }} />
        </div>
      )}
    </>
  );
}

function ReviewPanel({ summary }: { summary: RuntimeState["pendingSummary"] }) {
  const [open, setOpen] = useState(false);
  const lines = Object.entries(summary.byUser)
    .sort((a, b) => b[1].count - a[1].count)
    .map(
      ([user, info]) =>
        `@${user.padEnd(20)} ${String(info.count).padStart(4)}  (${info.photos}p ${info.videos}v)`,
    );
  return (
    <div class="review">
      <div class="review-header">
        <strong>
          {summary.tweetCount} {summary.tweetCount === 1 ? "post" : "posts"} ·{" "}
          {summary.photoCount} {summary.photoCount === 1 ? "photo" : "photos"},{" "}
          {summary.videoCount} {summary.videoCount === 1 ? "video" : "videos"}
        </strong>
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
  captured,
  state,
  status,
  folder,
  maxPages,
  incremental,
  fullScan,
  refreshKey,
  onRefresh,
  switchToRun,
}: {
  captured: CapturedSummary | null;
  state: RuntimeState | null;
  status: RuntimeState["status"];
  folder: string;
  maxPages: number;
  incremental: boolean;
  fullScan: boolean;
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

  useEffect(() => {
    loadRows();
  }, [refreshKey]);

  // Show the last Verify result even if the popup was closed while it ran.
  useEffect(() => {
    loadVerifyReports().then((saved) => setReports((prev) => ({ ...saved, ...prev })));
  }, [refreshKey]);

  const busy =
    status === "syncing" ||
    status === "downloading" ||
    status === "cancelling" ||
    status === "verifying";

  async function syncNow(source: SourceKey, userMode?: "media" | "tweets") {
    const res = await send({
      type: "startSync",
      options: { source, folder, maxPages, incremental, fullScan, userMode },
    });
    if (!res.ok) alert("Could not start sync: " + (res.error ?? "unknown"));
  }
  async function reset(source: SourceKey) {
    const label =
      source === "bookmarks"
        ? "your bookmarks history"
        : `the @${sourceUsername(source)} archive`;
    if (!confirm(`Reset ${label}?\nFiles on disk are not deleted.`)) return;
    await send({ type: "clearManifest", source });
    onRefresh();
    loadRows();
  }

  async function verifyNow(source: SourceKey) {
    setVerifying(source);
    try {
      const res = await send({
        type: "verifySource",
        source,
        folder,
        dryRun: true,
      });
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
      const res = await send({
        type: "verifySource",
        source,
        folder,
        dryRun: false,
      });
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
    clearVerifyReport(source);
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
          sources?: SourceKey[];
        }>;
        present?: Array<[string, number, SourceKey[]]>;
      };
      // v1: one source (classic explorer). v2: items carry their own sources
      // (shelf explorer's disk scan, which can span every source).
      if (parsed.schema !== "xshelf-missing-list/1" && parsed.schema !== "xshelf-missing-list/2") {
        setImportMsg("⚠ Not a recognised xshelf missing-list file.");
        return;
      }
      if (!parsed.source || !Array.isArray(parsed.items)) {
        setImportMsg("⚠ File is missing source or items.");
        return;
      }
      if (parsed.items.length === 0 && !parsed.present?.length) {
        setImportMsg("File has no missing items — nothing to queue.");
        return;
      }
      const res = await send({
        type: "importMissingList",
        source: parsed.source,
        folder,
        items: parsed.items,
        present: parsed.present,
      });
      if (!res.ok) {
        setImportMsg("⚠ Import failed: " + (res.error ?? "unknown"));
        return;
      }
      // Keep the message visible — do NOT auto-switch tabs. If the popup was
      // closed during the file picker, the auto-switch races against re-open
      // and the user lands on Sources with no signal anything happened.
      setImportMsg(
        `✓ Queued ${res.queued} item${res.queued === 1 ? "" : "s"} for download` +
          (res.reconciled ? `, marked ${res.reconciled} as on disk` : "") +
          (res.skipped ? ` (${res.skipped} skipped)` : "") +
          (res.queued ? ". Run → Download to fetch." : "."),
      );
      onRefresh();
    } catch (err) {
      setImportMsg(
        "⚠ Could not read file: " + ((err as Error).message ?? String(err)),
      );
    }
  }

  const pendingCount = state?.pendingSummary.count ?? 0;
  const hasPending = status === "ready" && pendingCount > 0;

  return (
    <>
      {hasPending && (
        <div class="banner ok pending-banner">
          <div class="banner-title">
            <strong>
              {pendingCount} item{pendingCount === 1 ? "" : "s"} pending
              download
            </strong>
          </div>
          <div class="banner-body">
            Switch to the <strong>Run</strong> tab and click{" "}
            <em>Download all</em> to fetch them.
          </div>
          <div style={{ marginTop: "6px" }}>
            <button class="primary" onClick={switchToRun}>
              Go to Run →
            </button>
          </div>
        </div>
      )}

      <div class="import-row">
        <label
          class="import-btn"
          title="Pick a missing-list JSON exported from the explorer's Find missing media"
        >
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
            <button class="link-btn" onClick={() => setImportMsg(null)}>
              dismiss
            </button>
          </div>
        )}
      </div>

      <div class="sources-list">
        {rows.length === 0 ? (
          <div class="status">
            No sources synced yet. Use the <strong>Run</strong> tab to start.
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.key}>
              <div class="source-row">
                <div class="source-row-label">
                  <strong>
                    {r.key === "bookmarks"
                      ? "Bookmarks"
                      : `@${sourceUsername(r.key)}`}
                  </strong>
                  <span class="source-meta">
                    {r.count} item{r.count === 1 ? "" : "s"} ·{" "}
                    {r.lastRun ? new Date(r.lastRun).toLocaleString() : "never"}
                  </span>
                </div>
                <div class="source-row-actions">
                  <button
                    disabled={busy || !isCaptureReadyForKey(captured, r.key)}
                    onClick={() =>
                      syncNow(r.key, isUserSource(r.key) ? "media" : undefined)
                    }
                    title={
                      isCaptureReadyForKey(captured, r.key)
                        ? undefined
                        : "Capture incomplete; visit the relevant X page first."
                    }
                  >
                    Sync
                  </button>
                  <button
                    disabled={busy || r.count === 0}
                    onClick={() => verifyNow(r.key)}
                    title={
                      r.count === 0
                        ? "No items to verify"
                        : "Dry-run check: which media is missing on disk?"
                    }
                  >
                    {verifying === r.key ? "Verifying…" : "Verify"}
                  </button>
                  <button
                    class="danger"
                    disabled={busy}
                    onClick={() => reset(r.key)}
                  >
                    Reset
                  </button>
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
          ))
        )}
      </div>

      <div class="row" style={{ marginTop: "10px" }}>
        <label for="new-handle">
          Archive a new user (or re-archive without navigating)
        </label>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            id="new-handle"
            type="text"
            placeholder="elonmusk"
            value={newHandle}
            onInput={(e: Event) =>
              setNewHandle((e.target as HTMLInputElement).value)
            }
            spellcheck={false}
            autocapitalize="off"
            style={{ flex: 1 }}
          />
          <button
            class="primary"
            disabled={
              busy ||
              !/^[A-Za-z0-9_]{1,15}$/.test(
                newHandle.trim().replace(/^@/, ""),
              ) ||
              !captured?.hasAuth ||
              !captured?.hasUserByScreenName ||
              !captured?.hasUserMedia
            }
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
        <MediaCoverageHint captured={captured} />
      </div>
    </>
  );
}

/**
 * Sources-tab counterpart to the Run banner's coverage note: user-media syncs
 * only reach the media views we've captured a request for, and this tab can
 * start one without the user ever being on a Media tab.
 */
function MediaCoverageHint({ captured }: { captured: CapturedSummary | null }) {
  const have = sortMediaVariants(captured?.userMediaVariants ?? []);
  const missing = missingMediaVariants(captured);
  if (have.length === 0) {
    return (
      <div class="status hint">
        No media view captured yet — open any user's Media tab and scroll once
        first.
      </div>
    );
  }
  if (missing.length === 0) {
    return (
      <div class="status hint">
        Media views captured: {have.map(mediaVariantLabel).join(", ")} — syncs
        crawl all of them.
        <MediaOpNote captured={captured} />
      </div>
    );
  }
  return (
    <div class="status hint">
      Media views captured: {have.map(mediaVariantLabel).join(", ")}. Missing{" "}
      {missing.map(mediaVariantLabel).join(" and ")} — X serves a separate
      timeline per media filter, so scroll{" "}
      <code>{missing.map((v) => mediaVariantPath("<handle>", v)).join(" and ")}</code>{" "}
      once to archive those too.
      <MediaOpNote captured={captured} />
    </div>
  );
}

/**
 * Which GraphQL operations the captured media views actually use. X renames
 * these (the one `UserMedia` operation became `UserPhotoTimeline` and friends)
 * and the extension follows automatically — but showing the names turns "my
 * capture is stale" from an invisible failure into something the user can see.
 */
function MediaOpNote({ captured }: { captured: CapturedSummary | null }) {
  const ops = captured?.userMediaOps ?? [];
  if (ops.length === 0) return null;
  return (
    <div style={{ marginTop: "2px", opacity: 0.75 }}>
      via {ops.map((o, i) => (
        <span key={o}>
          {i > 0 && ", "}
          <code>{o}</code>
        </span>
      ))}
    </div>
  );
}

function VerifyReportCard({
  report,
  busy,
  working,
  onQueue,
  onDismiss,
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
        <button class="link-btn" onClick={onDismiss}>
          dismiss
        </button>
      </div>
      {report.reconcilableCount > 0 && (
        <div class="verify-report-sub">
          {report.reconcilableCount} item
          {report.reconcilableCount === 1 ? " was" : "s were"} on disk but not
          tracked — these will be reconciled if you proceed.
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
      {!allGood && report.elsewhere && report.elsewhere.length > 0 && (
        <div class="verify-report-sub">
          The download history also has{" "}
          {report.elsewhere.map((e, i) => (
            <span key={e.dir}>
              {i > 0 && ", "}
              <strong>{e.count.toLocaleString()}</strong> under <code>{e.dir}/</code>
            </span>
          ))}
          . Those were saved while the download folder was somewhere else, so
          Verify can't match them, even if the files are on your drive now.
        </div>
      )}
      {!allGood && (
        <div class="verify-report-sub">
          This is based on the browser's download history, not your drive. Files
          that were moved after downloading (e.g. to another drive) or whose
          history was cleared show up as missing even when they're on disk.
          Before queuing a large number, run <strong>Check disk</strong> in the
          explorer: it opens the actual files and only lists what's really gone.
        </div>
      )}
      <div class="verify-report-hint">
        Read-only. Nothing is downloaded until you queue and click Download.
        {report.checkedAt && ` Checked ${new Date(report.checkedAt).toLocaleString()}.`}
      </div>
    </div>
  );
}

function isCaptureReadyForKey(
  c: CapturedSummary | null,
  key: SourceKey,
): boolean {
  if (!c?.hasAuth) return false;
  if (key === "bookmarks") return c.hasBookmarks;
  return c.hasUserByScreenName && (c.hasUserMedia || c.hasUserTweets);
}

// ---- Settings tab ----------------------------------------------------------

function SettingsTab({
  folder,
  setFolder,
  maxPages,
  setMaxPages,
  incremental,
  setIncremental,
  onRefresh,
  status,
}: {
  folder: string;
  setFolder: (v: string) => void;
  maxPages: number;
  setMaxPages: (v: number) => void;
  incremental: boolean;
  setIncremental: (v: boolean) => void;
  onRefresh: () => void;
  status: RuntimeState["status"];
}) {
  const busy =
    status === "syncing" ||
    status === "downloading" ||
    status === "cancelling" ||
    status === "verifying";
  return (
    <>
      <div class="row">
        <label for="folder">Folder name (inside Downloads/)</label>
        <input
          id="folder"
          type="text"
          value={folder}
          onInput={(e: Event) =>
            setFolder((e.target as HTMLInputElement).value)
          }
          disabled={busy}
        />
      </div>
      <ArchivePath folder={folder || "xshelf"} status={status} />
      <div class="row">
        <label for="maxPages">Max pages per sync (×100 items)</label>
        <input
          id="maxPages"
          type="number"
          min={1}
          max={500}
          value={maxPages}
          onInput={(e: Event) =>
            setMaxPages(
              parseInt((e.target as HTMLInputElement).value, 10) || 200,
            )
          }
          disabled={busy}
        />
      </div>
      <div class="row checkbox">
        <input
          id="incremental"
          type="checkbox"
          checked={incremental}
          onChange={(e: Event) =>
            setIncremental((e.target as HTMLInputElement).checked)
          }
          disabled={busy}
        />
        <label for="incremental">
          Incremental sync stops after a run of known posts. Full scan in Backup scans further back.
        </label>
      </div>
      <h3>Explorer</h3>
      <RebuildExplorerButton folder={folder} busy={busy || status === "unbookmarking"} />
      <h3>Extension data</h3>
      <div class="actions" style={{ marginTop: "16px" }}>
        <button
          class="danger"
          disabled={busy}
          onClick={async () => {
            if (
              !confirm(
                "WIPE ALL EXTENSION DATA?\nAll manifests, pending list, captured auth. Files on disk are NOT deleted.",
              )
            )
              return;
            await send({ type: "wipeAll" });
            onRefresh();
          }}
        >
          Wipe all data
        </button>
      </div>
      <div class="status hint" style={{ marginTop: "10px" }}>
        Wipe is destructive: clears every source's manifest and the captured
        session. Useful if state gets stuck. Files in Downloads/ are untouched.
      </div>
    </>
  );
}

function ArchivePath({ folder, status }: { folder: string; status: RuntimeState["status"] }) {
  const [root, setRoot] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let current = true;
    void loadDownloadRoot().then((value) => { if (current) setRoot(value); });
    return () => { current = false; };
  }, [status]);

  const relative = folder.replace(/\\/g, "/");
  const fullPath = root === null ? null : `${root.replace(/\/+$/, "")}/${relative}`;
  const path = fullPath && root && /^(?:[a-z]:(?:\/|$)|\/\/)/i.test(root)
    ? fullPath.replace(/\//g, "\\")
    : fullPath;

  useEffect(() => { setFeedback(""); }, [path]);

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  return (
    <div class="archive-path">
      <span class="archive-path-label">Archive path</span>
      {path ? (
        <button
          type="button"
          class="copy-path"
          title="Copy archive path"
          aria-label={`Copy archive path: ${path}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(path);
              setFeedback("Copied");
            } catch {
              setFeedback("Could not copy");
            }
          }}
        >
          <code>{path}</code>
          <span class="copy-path-action" role="status">{feedback || "Copy"}</span>
        </button>
      ) : (
        <span class="status">The full path will appear after the first backup.</span>
      )}
    </div>
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
  captured,
  state,
  status,
  folder,
  onRefresh,
}: {
  captured: CapturedSummary | null;
  state: RuntimeState | null;
  status: RuntimeState["status"];
  folder: string;
  onRefresh: () => void;
}) {
  const [count, setCount] = useState(100);
  const [order, setOrder] = useState<UnbookmarkOptions["order"]>(
    "newest-bookmarked-first",
  );
  const [usernameFilter, setUsernameFilter] = useState("");
  const [fixGhosts, setFixGhosts] = useState(true);
  const [preview, setPreview] = useState<UnbookmarkReport | null>(null);
  const [running, setRunning] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalBookmarks, setTotalBookmarks] = useState<number | null>(null);

  const busy =
    status === "syncing" ||
    status === "downloading" ||
    status === "cancelling" ||
    status === "verifying" ||
    status === "unbookmarking";

  // Load the bookmarks manifest just to show the user how many entries exist.
  useEffect(() => {
    let cancelled = false;
    send({ type: "getManifest", source: "bookmarks" }).then((r) => {
      if (cancelled || !r.ok) return;
      const all = Object.values(r.manifest.bookmarks);
      const active = all.filter((b) => !b.unbookmarkedAt).length;
      setTotalBookmarks(active);
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  function buildOptions(dryRun: boolean): UnbookmarkOptions {
    return {
      source: "bookmarks",
      order,
      usernameFilter: usernameFilter.trim().replace(/^@/, "") || undefined,
      count,
      dryRun,
      fixGhosts,
    };
  }

  async function runPreview() {
    setError(null);
    setRunning(true);
    try {
      const res = await send({
        type: "unbookmark",
        options: buildOptions(true),
        folder,
      });
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
      setError(
        confirmation == null ? null : "Did not type DELETE — nothing changed.",
      );
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const res = await send({
        type: "unbookmark",
        options: buildOptions(false),
        folder,
      });
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
    !!captured?.hasAuth &&
    !!captured?.hasBookmarks &&
    !!captured?.hasDeleteBookmark &&
    !!captured?.hasDeleteBookmarkBody;

  return (
    <>
      <div class="banner warn">
        <div class="banner-title">Cleanup unbookmarks from your X account.</div>
        <div class="banner-body">
          Walks your <strong>live x.com bookmarks list</strong> page-by-page (no
          dependency on the local manifest) so the preview always matches what's
          actually on your account. Your local archive (media + text + metadata)
          is <strong>never modified</strong>. A backup is written before any
          delete.
        </div>
      </div>

      <div class="status hint" style={{ marginTop: "6px" }}>
        Local archive size: <strong>{totalBookmarks ?? "…"}</strong>{" "}
        <span class="source-meta">
          (unchanged by cleanup — only x.com is touched)
        </span>
      </div>

      {!captureReady && (
        <div class="status warn" style={{ marginTop: "6px" }}>
          {captured?.hasAuth
            ? null
            : "Visit x.com so the extension can capture your session. "}
          {captured?.hasBookmarks
            ? null
            : "Scroll x.com/i/history once to capture the Bookmarks endpoint. "}
          {captured?.hasDeleteBookmark && captured?.hasDeleteBookmarkBody
            ? null
            : "Remove ONE bookmark manually on x.com/i/history so the DeleteBookmark queryId AND request body shape are captured."}
        </div>
      )}

      <div class="capture-status" style={{ marginTop: "8px" }}>
        <div class="capture-status-title">Capture status</div>
        <div class="capture-status-grid">
          <CaptureRow
            ok={!!captured?.hasAuth}
            label="Session auth"
            hint="Visit x.com."
          />
          <CaptureRow
            ok={!!captured?.hasBookmarks}
            label="Bookmarks endpoint"
            hint="Scroll x.com/i/history."
          />
          <CaptureRow
            ok={!!captured?.hasDeleteBookmark}
            label="DeleteBookmark queryId"
            hint="Remove ANY bookmark manually."
          />
          <CaptureRow
            ok={!!captured?.hasDeleteBookmarkBody}
            label="DeleteBookmark body shape"
            hint="(captured at the same time)"
          />
          <CaptureRow
            ok={!!captured?.hasCreateBookmark}
            label="CreateBookmark queryId"
            hint="Bookmark a tweet (any unbookmarked tweet)."
            emphasise={fixGhosts && !captured?.hasCreateBookmark}
          />
          <CaptureRow
            ok={!!captured?.hasCreateBookmarkBody}
            label="CreateBookmark body shape"
            hint="(captured at the same time)"
            emphasise={fixGhosts && !captured?.hasCreateBookmarkBody}
          />
        </div>
        {fixGhosts &&
          (!captured?.hasCreateBookmark ||
            !captured?.hasCreateBookmarkBody) && (
            <div class="status warn" style={{ marginTop: "6px" }}>
              <strong>
                Ghost-fix is ON but CreateBookmark isn't captured.
              </strong>{" "}
              Bookmark ONE tweet on x.com (any tweet you don't already have
              bookmarked — the popup will say "added to bookmarks") and the row
              above will flip ✓. Until then ghost-fix won't run.
            </div>
          )}
      </div>

      <div class="row" style={{ marginTop: "10px" }}>
        <label for="cleanup-order">Order</label>
        <select
          id="cleanup-order"
          value={order}
          disabled={running || busy}
          onChange={(e: Event) =>
            setOrder(
              (e.target as HTMLSelectElement)
                .value as UnbookmarkOptions["order"],
            )
          }
        >
          {Object.entries(ORDER_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
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
          onInput={(e: Event) =>
            setUsernameFilter((e.target as HTMLInputElement).value)
          }
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
            setCount(
              Math.max(
                1,
                Math.min(
                  1000,
                  parseInt((e.target as HTMLInputElement).value, 10) || 100,
                ),
              ),
            )
          }
        />
      </div>

      <div class="row checkbox">
        <input
          id="cleanup-fix-ghosts"
          type="checkbox"
          checked={fixGhosts}
          disabled={running || busy}
          onChange={(e: Event) =>
            setFixGhosts((e.target as HTMLInputElement).checked)
          }
        />
        <label
          for="cleanup-fix-ghosts"
          title="When X says a tweet isn't bookmarked but it shows up in your bookmarks list, re-add it then re-remove it to force X's two stores into agreement. Requires capturing CreateBookmark (bookmark one tweet manually)."
        >
          Fix ghost bookmarks (re-add then remove)
          {!captured?.hasCreateBookmark || !captured?.hasCreateBookmarkBody ? (
            <span class="source-meta">
              {" "}
              · capture pending — bookmark one item manually first
            </span>
          ) : null}
        </label>
      </div>

      <div class="actions">
        <button onClick={runBackup} disabled={running || busy}>
          Back up manifest
        </button>
        <button
          onClick={async () => {
            if (
              !confirm(
                "Clear cleanup history?\n\nThe next scan will no longer skip tweets you've previously unbookmarked. Use this if you've re-bookmarked items and want cleanup to pick them up again.",
              )
            )
              return;
            await send({ type: "clearCleanupHistory" });
            setError(null);
            setBackupPath(null);
            setPreview(null);
          }}
          disabled={running || busy}
          title="Wipe the list of previously-handled tweet IDs. Useful after re-bookmarking items."
        >
          Forget history
        </button>
        <button
          onClick={runPreview}
          disabled={running || busy}
          title="Crawl x.com to see what would be unbookmarked. May take a while for non-newest-first orders."
        >
          {running ? "Scanning…" : "Preview (live scan)"}
        </button>
        <button
          class="danger"
          disabled={
            running ||
            busy ||
            !preview ||
            preview.preview.length === 0 ||
            !captureReady
          }
          onClick={runDelete}
          title={
            captureReady
              ? "Unbookmark the previewed batch"
              : "Capture not ready"
          }
        >
          {running ? "Unbookmarking…" : "Unbookmark batch"}
        </button>
        {status === "unbookmarking" && (
          <button onClick={() => send({ type: "cancelBackup" })}>Cancel</button>
        )}
      </div>

      {status === "unbookmarking" && state && <CleanupProgress state={state} />}

      {backupPath && (
        <div class="status hint" style={{ marginTop: "6px" }}>
          Backup written to <code>{backupPath}</code>
        </div>
      )}

      {error && (
        <div class="status warn" style={{ marginTop: "6px" }}>
          {error}
        </div>
      )}

      {preview && (
        <div class="review" style={{ marginTop: "10px" }}>
          <div class="review-header">
            <strong>
              {preview.removed.length > 0 ||
              preview.alreadyGone.length > 0 ||
              preview.ghostsFixed.length > 0 ||
              preview.failed.length > 0
                ? `Run done — ${preview.removed.length} removed${preview.ghostsFixed.length ? `, ${preview.ghostsFixed.length} ghosts fixed` : ""}, ${preview.alreadyGone.length} already gone, ${preview.failed.length} failed.`
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
              {preview.failed.length > 10
                ? `\n\n…and ${preview.failed.length - 10} more`
                : ""}
            </pre>
          )}
          {preview.preview.length > 0 && preview.failed.length === 0 && (
            <pre>
              {preview.preview
                .slice(0, 20)
                .map(
                  (p) =>
                    `@${p.username.padEnd(20)} ${p.text.replace(/\s+/g, " ").slice(0, 60)}`,
                )
                .join("\n")}
              {preview.preview.length > 20
                ? `\n…and ${preview.preview.length - 20} more`
                : ""}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

function CaptureRow({
  ok,
  label,
  hint,
  emphasise,
}: {
  ok: boolean;
  label: string;
  hint: string;
  emphasise?: boolean;
}) {
  return (
    <div class={`capture-row ${emphasise && !ok ? "emphasise" : ""}`}>
      <span class={`capture-mark ${ok ? "ok" : "missing"}`}>
        {ok ? "✓" : "✗"}
      </span>
      <span class="capture-label">{label}</span>
      {!ok && <span class="capture-hint">{hint}</span>}
    </div>
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
      pct =
        state.mediaTotal > 0
          ? Math.round((state.mediaDone / state.mediaTotal) * 100)
          : null;
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
        <strong>xshelf</strong> backs up your X (Twitter) bookmarks and lets you
        archive other users' content to a single shared folder. Read-only —
        never modifies the bookmarks on your account.
      </p>

      <h3>How a sync works</h3>
      <ol>
        <li>
          Open the relevant X page (your bookmarks or any user's profile/media
          tab).
        </li>
        <li>
          For a user's media: X splits the Media tab into filtered views (
          <code>/media</code> and <code>/media?filter=photo</code>), and each is
          a separate timeline served by its own endpoint (<code>UserMedia</code>{" "}
          became <code>UserPhotoTimeline</code> and friends). Scroll each view
          once — the extension captures whatever request that view actually
          makes and replays it, so X renaming things again costs you a scroll,
          not an update. All views merge into a single archive.
        </li>
        <li>
          Open this popup; the <strong>Run</strong> tab auto-detects what's on
          the active tab.
        </li>
        <li>
          Click sync. The extension catalogues tweets into a per-source
          manifest, no media downloaded yet.
        </li>
        <li>
          Review the pending list and click <strong>Download all</strong>. Files
          land at
          <code>
            {folder || "xshelf"}
            /media/&lt;author&gt;/&lt;tweet-id&gt;_&lt;n&gt;.&lt;ext&gt;
          </code>
          .
        </li>
        <li>
          Click <strong>Explorer</strong> (top right) — opens the master{" "}
          <code>{folder || "xshelf"}/index.html</code>.
        </li>
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
        The <strong>Cleanup</strong> tab removes bookmarks from your X account
        in batches. Your local archive — media files, text, all metadata — is{" "}
        <strong>never modified</strong>. A JSON backup of the bookmarks manifest
        is written to
        <code>{folder || "xshelf"}/backups/</code> before any delete runs.
      </p>
      <ol>
        <li>
          Make sure you've synced recently so the local archive is current.
        </li>
        <li>
          On the Cleanup tab pick an order, optional @username filter, and batch
          size.
        </li>
        <li>
          Click <strong>Preview</strong> to see exactly which tweets will be
          unbookmarked.
        </li>
        <li>
          Click <strong>Unbookmark batch</strong> and type <code>DELETE</code>{" "}
          to confirm.
        </li>
      </ol>
      <p class="status hint">
        To capture the DeleteBookmark queryId you need to remove ONE bookmark
        manually on x.com first (any one). The extension picks the queryId up
        from that request.
      </p>

      <h3>Repair missing media</h3>
      <ol>
        <li>Open the explorer for the source you want to check.</li>
        <li>
          Click <strong>Find missing</strong> in the toolbar, then{" "}
          <strong>Scan</strong>. The browser tries to load every file from disk
          and lists the ones it couldn't open.
        </li>
        <li>
          Click <strong>Download list</strong> to save the missing-list JSON.
        </li>
        <li>
          Back here, in <strong>Sources</strong> →{" "}
          <strong>Import missing list…</strong>, pick that file.
        </li>
        <li>
          The pending queue is populated — switch to <strong>Run</strong> and
          click <strong>Download all</strong>.
        </li>
      </ol>

      <h3>Privacy</h3>
      <p>
        The exported HTML is strictly offline — no remote calls, no telemetry,
        no fonts from CDNs. Missing media shows a hyperlink to the original
        tweet (a click-through, not an automatic fetch).
      </p>

      <p class="status hint">
        SW version: {SW_VERSION} ·{" "}
        <a
          href="#"
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            chrome.tabs.create({ url: "https://x.com/i/history" });
          }}
        >
          Open x.com history
        </a>
      </p>
    </div>
  );
}

// ---- Open-explorer helper (shared by Run tab) ------------------------------

async function openMaster(folder: string) {
  try {
    // Prefer the index in the CURRENT download directory — after moving it,
    // history still holds index.html entries pointing at the old location.
    const root = await loadDownloadRoot();
    let items = root
      ? await chrome.downloads.search({
          filenameRegex: absolutePathRegex(root, `${folder || "xshelf"}/index.html`),
          state: "complete",
          limit: 1,
          orderBy: ["-startTime"],
        })
      : [];
    if (items.length === 0) {
      items = await chrome.downloads.search({
        filenameRegex: ".*[\\\\/]index\\.html$",
        state: "complete",
        limit: 1,
        orderBy: ["-startTime"],
      });
    }
    if (items.length === 0) {
      items = await chrome.downloads.search({
        filenameRegex: ".*explorer\\.html$",
        state: "complete",
        limit: 1,
        orderBy: ["-startTime"],
      });
    }
    if (items.length === 0) {
      alert("No explorer yet — run a sync first.");
      return;
    }
    try {
      chrome.downloads.open(items[0].id);
    } catch {
      chrome.downloads.show(items[0].id);
    }
  } catch (e) {
    alert("Couldn't open explorer: " + ((e as Error).message ?? String(e)));
  }
}
