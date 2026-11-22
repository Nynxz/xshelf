/**
 * Tracks downloads we initiate via chrome.downloads.download so we can:
 *   - await their completion (resolve when state === complete)
 *   - cancel them (chrome.downloads.cancel)
 * URL-keyed because chrome.downloads.onChanged delivers ids only after the
 * download() callback fires; the URL is stable from before we even call it.
 */

interface PendingEntry {
  filename: string;
  conflictAction: chrome.downloads.FilenameConflictAction;
  resolve: (id: number) => void;
  reject: (err: Error) => void;
  id: number | null;
}

const xbdByUrl = new Map<string, PendingEntry>();
const xbdById = new Map<number, PendingEntry>();

chrome.downloads.onChanged.addListener((delta) => {
  const entry = xbdById.get(delta.id);
  if (!entry) return;
  if (delta.state?.current === "complete") {
    entry.resolve(delta.id);
    cleanup(entry);
  } else if (delta.state?.current === "interrupted") {
    entry.reject(new Error(delta.error?.current || "interrupted"));
    cleanup(entry);
  }
});

function cleanup(entry: PendingEntry): void {
  if (entry.id != null) xbdById.delete(entry.id);
  for (const [u, v] of xbdByUrl.entries()) {
    if (v === entry) xbdByUrl.delete(u);
  }
}

export async function downloadFile(
  url: string,
  filename: string,
  conflictAction: chrome.downloads.FilenameConflictAction = "overwrite",
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const entry: PendingEntry = { filename, conflictAction, resolve, reject, id: null };
    xbdByUrl.set(url, entry);
    chrome.downloads.download(
      { url, filename, conflictAction, saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) {
          cleanup(entry);
          reject(new Error(err.message ?? "download failed"));
          return;
        }
        if (typeof id !== "number") {
          cleanup(entry);
          reject(new Error("no download id"));
          return;
        }
        entry.id = id;
        xbdById.set(id, entry);
      },
    );
  });
}

export async function cancelAllDownloads(): Promise<void> {
  const ids = [...xbdById.keys()];
  for (const id of ids) {
    try {
      await chrome.downloads.cancel(id);
    } catch {
      // ignore
    }
  }
  for (const entry of new Set(xbdByUrl.values())) {
    try {
      entry.reject(new Error("cancelled"));
    } catch {
      // ignore
    }
  }
  xbdByUrl.clear();
  xbdById.clear();
}

const DOWNLOAD_ROOT_KEY = "xbd_download_root";

function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Write a tiny probe file to `<folder>/xbd-probe.txt` and read back the absolute
 * path Chrome recorded for it. Stripping the relative part gives Chrome's
 * *current* download directory, spelled exactly the way Chrome spells it in
 * DownloadItem.filename (symlinked or resolved — doesn't matter, it's
 * consistent with every download made from now on).
 *
 * Why: the existence checks below used to match only the relative path tail,
 * so after moving the download directory (e.g. to another drive behind a
 * symlink) every history entry from the OLD directory still matched and
 * pre-flight/audit/verify skipped files that were never written to the new
 * one. Anchoring on the probed root makes old-directory entries not count.
 *
 * Also doubles as a fail-fast writability check: if Chrome can't write
 * through the configured directory, this throws once with the interrupt
 * reason instead of every media item failing individually.
 *
 * The probe is removed from disk and erased from history afterwards.
 */
export async function probeDownloadRoot(folder: string): Promise<string> {
  const rel = `${folder}/xbd-probe.txt`;
  let id: number;
  try {
    id = await downloadFile("data:text/plain;base64,eGJk", rel, "overwrite");
  } catch (e) {
    throw new Error(
      `Chrome couldn't write to "${folder}/" in your download directory ` +
        `(${(e as Error).message}). Check the directory exists, the symlink ` +
        `target is mounted and writable, and — for Flatpak/Snap browsers — ` +
        `that the sandbox is allowed to access the symlink target.`,
    );
  }
  const [item] = await chrome.downloads.search({ id });
  const actual = normalizeSep(item?.filename ?? "");
  const suffix = "/" + normalizeSep(rel);
  try {
    await chrome.downloads.removeFile(id);
  } catch {
    // ignore — leaving a 3-byte probe behind is harmless
  }
  try {
    await chrome.downloads.erase({ id });
  } catch {
    // ignore
  }
  if (!actual.endsWith(suffix)) {
    throw new Error(
      `Probe landed at an unexpected path (${actual || "unknown"}); expected it to end with ${suffix}.`,
    );
  }
  const root = actual.slice(0, -suffix.length);
  try {
    await chrome.storage.local.set({ [DOWNLOAD_ROOT_KEY]: root });
  } catch {
    // ignore — only used by the popup's "Open explorer"
  }
  return root;
}

/** Last download root seen by probeDownloadRoot, or null if none yet. */
export async function loadDownloadRoot(): Promise<string | null> {
  try {
    const data = await chrome.storage.local.get(DOWNLOAD_ROOT_KEY);
    return (data[DOWNLOAD_ROOT_KEY] as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Regex-escape a path, accepting either separator (Chrome reports native ones). */
function escapePathRegex(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "[/\\\\]");
}

/** Regex matching `<root>/<relative>` exactly, with either separator. */
export function absolutePathRegex(root: string, relative: string): string {
  return "^" + escapePathRegex(normalizeSep(root) + "/" + normalizeSep(relative)) + "$";
}

/**
 * One-shot snapshot of Chrome's download history under `<root>/<folder>/`,
 * for answering "is this file already downloaded?" for many files at once.
 *
 * This replaced a per-file `chrome.downloads.search`: each search scans the
 * whole history, so checking N files cost N × history-size regex matches —
 * with ~70k files that pegged the CPU for minutes. One search + a Set lookup
 * per file is linear.
 *
 * Paths are anchored on `root` (from probeDownloadRoot) so entries from a
 * previous download directory don't count, and entries Chrome knows were
 * deleted (`exists === false`) are dropped. `exists` isn't refreshed in real
 * time, so this is still history, not a disk check (the explorer's
 * Check disk is that).
 */
export interface DownloadIndex {
  /** Completed downloads indexed (after filtering). */
  size: number;
  /** A completed download sits at exactly `<root>/<relative>`. Robust to URL drift. */
  hasPath(relative: string): boolean;
  /** As hasPath, and that download was of `url`. */
  hasUrlAt(url: string, relative: string): boolean;
}

export async function buildDownloadIndex(root: string, folder: string): Promise<DownloadIndex> {
  const base = normalizeSep(root) + "/";
  const items = await chrome.downloads.search({
    filenameRegex: "^" + escapePathRegex(base + normalizeSep(folder) + "/"),
    state: "complete",
    limit: 0, // 0 = no limit
  });
  const paths = new Set<string>();
  const urlAt = new Set<string>();
  for (const it of items) {
    if (it.exists === false) continue;
    const f = normalizeSep(it.filename || "");
    paths.add(f);
    urlAt.add(`${it.url}\n${f}`);
    if (it.finalUrl && it.finalUrl !== it.url) urlAt.add(`${it.finalUrl}\n${f}`);
  }
  return {
    size: paths.size,
    hasPath: (rel) => paths.has(base + normalizeSep(rel)),
    hasUrlAt: (url, rel) => urlAt.has(`${url}\n${base}${normalizeSep(rel)}`),
  };
}

/**
 * Where else has Chrome recorded `<folder>/media/` downloads? Groups history
 * entries that are NOT under the current `root` by the directory holding
 * `<folder>/`, largest first. Explains a Verify that reports lots missing
 * after the download directory moved (those files exist, just recorded
 * under the old path). One history search.
 */
export async function downloadsElsewhere(
  root: string,
  folder: string,
): Promise<Array<{ dir: string; count: number }>> {
  const marker = "/" + normalizeSep(folder) + "/media/";
  const items = await chrome.downloads.search({
    filenameRegex: escapePathRegex(marker),
    state: "complete",
    limit: 0,
  });
  const base = normalizeSep(root) + "/";
  const counts = new Map<string, number>();
  for (const it of items) {
    const f = normalizeSep(it.filename || "");
    if (f.startsWith(base)) continue;
    const dir = f.slice(0, f.indexOf(marker)) || "(unknown)";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
