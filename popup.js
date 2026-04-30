const $ = (id) => document.getElementById(id);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateUpdate") render(msg.state);
});

const POPUP_EXPECTS_SW_VERSION = "v8-sort-fix";

async function refreshAll() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getRunState" });
    if (res && res.ok) {
      if (res.version !== POPUP_EXPECTS_SW_VERSION) {
        $("runStatus").textContent = `Service worker is on stale code (${res.version || "v1"}, expected ${POPUP_EXPECTS_SW_VERSION}). Toggle the extension off+on at chrome://extensions to force-reload the SW.`;
        $("runStatus").classList.add("warn");
        return;
      }
      render(res.state);
      renderCapture(res.captured);
    }
  } catch {
    $("runStatus").textContent = "Service worker not reachable. Reload the extension.";
  }
  await refreshManifestStats();
}
refreshAll();
setInterval(refreshAll, 5000);

function renderCapture(c) {
  if (!c) return;
  if (c.hasAuth && c.queryId && c.operation) {
    $("captureStatus").textContent = `Capture OK (${c.operation}, queryId=${c.queryId})`;
    $("captureStatus").classList.remove("warn");
  } else {
    const missing = [];
    if (!c.hasAuth) missing.push("auth");
    if (!c.queryId) missing.push("queryId");
    if (!c.operation) missing.push("operation");
    $("captureStatus").textContent = `Capture missing: ${missing.join(", ")}. Open x.com/i/bookmarks and scroll once.`;
    $("captureStatus").classList.add("warn");
  }
}

function render(state) {
  if (!state) return;
  const status = state.status || "idle";

  // ---- Status line ----
  const summary = state.pendingSummary || { count: 0, tweetCount: 0, photoCount: 0, videoCount: 0, byUser: {} };
  let label;
  switch (status) {
    case "syncing":     label = `Syncing — ${state.currentPhase || "…"}`; break;
    case "ready":       label = `Ready: ${summary.count} media items pending review.`; break;
    case "downloading": label = `Downloading…`; break;
    case "cancelling":  label = "Cancelling…"; break;
    case "cancelled":   label = "Cancelled."; break;
    case "done":        label = "Done."; break;
    case "error":       label = `Error: ${state.errorMessage || "?"}`; break;
    case "interrupted": label = `Interrupted (${state.errorMessage || "service worker restart"})`; break;
    default:            label = "Idle.";
  }
  if (status === "syncing" && state.totalSeen) {
    label += ` — ${state.totalSeen} seen, ${state.newCount} new across ${state.pageCount} page(s)`;
  } else if (status === "downloading" && state.mediaTotal) {
    label += ` — ${state.mediaDone}/${state.mediaTotal}`;
  }
  $("runStatus").textContent = label;
  $("runStatus").classList.toggle("warn", status === "error" || status === "interrupted");

  // ---- Progress bar ----
  if (status === "downloading" && state.mediaTotal) {
    $("progressBar").hidden = false;
    const pct = Math.min(100, Math.round((state.mediaDone / state.mediaTotal) * 100));
    $("progressBar").querySelector(".bar").style.width = pct + "%";
  } else {
    $("progressBar").hidden = true;
  }

  // ---- Review panel ----
  const showReview = status === "ready" && summary.count > 0;
  $("reviewPanel").hidden = !showReview;
  if (showReview) {
    $("reviewSummary").textContent = `${summary.tweetCount} tweets · ${summary.count} media (${summary.photoCount} photos, ${summary.videoCount} videos)`;
    const lines = Object.entries(summary.byUser || {})
      .sort((a, b) => b[1].count - a[1].count)
      .map(([user, info]) => `@${user.padEnd(20)} ${String(info.count).padStart(4)}  (${info.photos}p ${info.videos}v)`);
    $("reviewBreakdown").textContent = lines.join("\n");
  }

  // ---- Buttons ----
  const isBusy = status === "syncing" || status === "downloading" || status === "cancelling";
  $("startSync").disabled = isBusy;
  $("startSync").hidden = status === "ready";

  $("startDownload").hidden = status !== "ready";
  $("startDownload").disabled = false;

  $("discard").hidden = status !== "ready";
  $("discard").disabled = false;

  $("cancel").disabled = !(status === "syncing" || status === "downloading");
  $("reset").disabled = isBusy;

  // ---- Log ----
  const log = $("log");
  log.textContent = (state.log || []).join("\n");
  log.scrollTop = log.scrollHeight;
}

async function refreshManifestStats() {
  const el = $("manifestStats");
  try {
    const res = await chrome.runtime.sendMessage({ type: "getManifest" });
    const m = res && res.manifest;
    if (!m || !m.bookmarks || Object.keys(m.bookmarks).length === 0) {
      el.textContent = "History: empty.";
      return;
    }
    const count = Object.keys(m.bookmarks).length;
    const last = m.lastRun ? new Date(m.lastRun.finishedAt).toLocaleString() : "never";
    el.textContent = `History: ${count} bookmarks tracked. Last run: ${last}.`;
  } catch {
    el.textContent = "History: (couldn't read)";
  }
}

// ----- Buttons -----

$("startSync").addEventListener("click", async () => {
  const folder = ($("folder").value || "x-bookmarks").trim();
  const maxPages = Math.max(1, parseInt($("maxPages").value, 10) || 200);
  const incremental = $("incremental").checked;
  const res = await chrome.runtime.sendMessage({
    type: "startSync",
    options: { folder, maxPages, incremental }
  });
  if (!res || !res.ok) alert("Could not start sync: " + (res && res.error || "unknown"));
});

$("startDownload").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "startDownload" });
  if (!res || !res.ok) alert("Could not start download: " + (res && res.error || "unknown"));
});

$("discard").addEventListener("click", async () => {
  if (!confirm("Discard the pending list? The manifest is not affected — you can re-run sync later.")) return;
  await chrome.runtime.sendMessage({ type: "discardPending" });
});

$("cancel").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cancelBackup" });
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Reset history? Future runs will re-fetch everything. Files on disk are not deleted; the audit will reconcile them.")) return;
  await chrome.runtime.sendMessage({ type: "clearManifest" });
  await refreshManifestStats();
});

$("wipe").addEventListener("click", async () => {
  if (!confirm("WIPE ALL EXTENSION DATA?\n\nThis clears the manifest, pending list, captured auth, and runtime state. Files on disk (Downloads/) are NOT deleted.\n\nUse this if the extension is stuck or laggy.")) return;
  await chrome.runtime.sendMessage({ type: "wipeAll" });
  await refreshAll();
});

$("toggleBreakdown").addEventListener("click", () => {
  const el = $("reviewBreakdown");
  el.hidden = !el.hidden;
  $("toggleBreakdown").textContent = el.hidden ? "show breakdown" : "hide breakdown";
});

$("open-bookmarks").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: "https://x.com/i/bookmarks" });
});

$("open-chrome-settings").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: "chrome://settings/?search=download" });
});
