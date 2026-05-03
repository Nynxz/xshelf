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

/**
 * Has Chrome ever finished downloading this URL? Used to skip re-downloading
 * files we already have. Doesn't pass `exists: true` because that flag is
 * not refreshed in real time and gives false negatives.
 */
export async function existsByUrl(url: string): Promise<boolean> {
  try {
    const items = await chrome.downloads.search({ url, state: "complete", limit: 1 });
    return items != null && items.length > 0;
  } catch {
    return false;
  }
}

/**
 * Stronger version of existsByUrl: not only does the URL appear in download
 * history, but at least one of the recorded downloads landed at a path whose
 * relative tail matches `expectedRelative`. This is what pre-flight and audit
 * need so that downloading the same URL into a different source's folder
 * doesn't get falsely skipped.
 *
 * Example: bookmark of an @elonmusk tweet was downloaded to
 *   ~/Downloads/xshelf/bookmarks/media/elonmusk/123_0.jpg
 * Now an @elonmusk user-archive sync expects the same image at
 *   ~/Downloads/xshelf/users/elonmusk/media/elonmusk/123_0.jpg
 * Same URL, different path. existsByUrl would say "yes, downloaded" — wrong.
 * existsAtPath verifies the path tail matches.
 */
export async function existsAtPath(url: string, expectedRelative: string): Promise<boolean> {
  try {
    const items = await chrome.downloads.search({ url, state: "complete", limit: 10 });
    if (!items || !items.length) return false;
    const target = expectedRelative.replace(/\\/g, "/");
    return items.some((item) => {
      const actual = (item.filename || "").replace(/\\/g, "/");
      return actual.endsWith(target);
    });
  } catch {
    return false;
  }
}

/**
 * Bounded-concurrency map. Critical for chrome.downloads.search calls — without
 * this, audit/pre-flight saturated Chrome's download manager and froze the browser.
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = undefined as unknown as R;
      }
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, items.length);
    }
  }
  const workers: Promise<void>[] = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
