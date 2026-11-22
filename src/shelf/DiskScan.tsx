import { useEffect, useRef, useState } from "preact/hooks";
import type { MediaItem } from "./data";
import { IClose } from "./icons";

/**
 * Probe one local file by asking the browser to load it. From file:// the
 * image/video loader IS the filesystem check — there's no other API — and
 * unlike the extension's Verify (download history) it sees what's really on
 * disk, including files deleted or never written.
 */
function probe(item: MediaItem): Promise<boolean> {
  return new Promise((resolve) => {
    let el: HTMLImageElement | HTMLVideoElement;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      inFlight.delete(el);
      resolve(ok);
    };
    if (item.m.kind === "video") {
      const v = document.createElement("video");
      el = v;
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => {
        finish(true);
        v.removeAttribute("src");
        v.load();
      };
      v.onerror = () => finish(false);
      inFlight.add(v);
      v.src = item.path;
    } else {
      const img = new Image();
      el = img;
      img.onload = () => {
        finish(true);
        img.src = ""; // drop the decoded image right away
      };
      img.onerror = () => finish(false);
      inFlight.add(img);
      img.src = item.path;
      // Already in the memory cache (e.g. currently on screen): settled
      // synchronously, and the load event isn't guaranteed to follow.
      if (img.complete) finish(img.naturalWidth > 0);
    }
    setTimeout(() => finish(false), 10000);
  });
}

/**
 * Probe elements live only in closures; without a strong reference Chrome may
 * collect one before its load/error event fires, and the probe never settles.
 */
const inFlight = new Set<HTMLImageElement | HTMLVideoElement>();

// Kept low on purpose: each probe reads a full-size file, and a scan of a
// large archive shouldn't make the rest of the machine sluggish.
const CONCURRENCY = 6;

export interface ScanResult {
  scannedAt: string;
  scope: string;
  total: number;
  missing: MediaItem[];
  /** Items confirmed on disk (for resyncing flags on import). */
  present: MediaItem[];
}

/**
 * "Check disk" dialog: loads every media file in the current view, reports
 * which are missing, and saves a re-download list the extension popup can
 * import (Sources → Import missing list…) and then fetch with Download.
 */
export function DiskScan({
  items,
  scope,
  onClose,
  onResult,
  onShowMissing,
}: {
  items: MediaItem[];
  scope: string;
  onClose: () => void;
  onResult: (r: ScanResult) => void;
  onShowMissing: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "scanning" | "done">("idle");
  const [done, setDone] = useState(0);
  const [missingCount, setMissingCount] = useState(0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const cancel = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "scanning") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  async function start() {
    cancel.current = false;
    setPhase("scanning");
    setDone(0);
    setMissingCount(0);
    const missing: MediaItem[] = [];
    const present: MediaItem[] = [];
    let next = 0;
    let completed = 0;
    const worker = async () => {
      while (!cancel.current) {
        const i = next++;
        if (i >= items.length) return;
        if (await probe(items[i])) present.push(items[i]);
        else missing.push(items[i]);
        completed++;
        // Breathe every so often so the page (and browser) stay responsive.
        if (completed % 200 === 0) await new Promise((r) => setTimeout(r, 30));
        if (completed % 25 === 0) {
          setDone(completed);
          setMissingCount(missing.length);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    // Keep list order stable (workers finish out of order).
    const order = new Map(items.map((it, i) => [it.key, i]));
    missing.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
    const r: ScanResult = {
      scannedAt: new Date().toISOString(),
      scope,
      total: cancel.current ? completed : items.length,
      missing,
      present,
    };
    setDone(completed);
    setMissingCount(missing.length);
    setResult(r);
    onResult(r);
    setPhase("done");
  }

  function saveList() {
    if (!result) return;
    const payload = {
      schema: "xshelf-missing-list/2",
      // v1 readers need a single source; v2 items carry their own.
      source: result.missing[0]?.post.sources[0] ?? "bookmarks",
      scannedAt: result.scannedAt,
      scope: result.scope,
      totalScanned: result.total,
      missingCount: result.missing.length,
      items: result.missing.map((i) => ({
        tweetId: i.post.b.id,
        username: i.post.b.username,
        mediaIndex: i.m.index,
        kind: i.m.kind,
        url: i.m.url,
        sources: i.post.sources,
      })),
      // What IS on disk, so the import fixes "downloaded" flags both ways.
      present: result.present.map((i) => [i.post.b.id, i.m.index, i.post.sources]),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xshelf-missing-${result.scannedAt.replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const pct = items.length ? Math.round((done / items.length) * 100) : 100;

  return (
    <div class="modal-scrim" onClick={(e) => e.target === e.currentTarget && phase !== "scanning" && onClose()}>
      <div ref={dialogRef} class="modal" role="dialog" aria-modal="true" aria-labelledby="scan-title">
        <div class="modal-head">
          <h2 id="scan-title">Check files on disk</h2>
          <button type="button" class="icon-btn" onClick={onClose} disabled={phase === "scanning"} aria-label="Close">
            <IClose size={18} />
          </button>
        </div>

        {phase === "idle" && (
          <>
            <p>
              Tries to open each of the <b>{items.length.toLocaleString()}</b> media files in the current view (
              {scope}) and lists the ones that aren't on disk. Narrow the view first (source, @user, type) to scan
              less.
            </p>
            <div class="modal-actions">
              <button type="button" class="btn-solid" onClick={start} disabled={items.length === 0}>
                Start scan
              </button>
            </div>
          </>
        )}

        {phase !== "idle" && (
          <>
            <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p class="scan-stats">
              {done.toLocaleString()} / {items.length.toLocaleString()} checked ·{" "}
              <b class={missingCount ? "warn" : ""}>{missingCount.toLocaleString()} missing</b>
            </p>
          </>
        )}

        {phase === "scanning" && (
          <div class="modal-actions">
            <button type="button" class="btn-ghost" onClick={() => (cancel.current = true)}>
              Stop
            </button>
          </div>
        )}

        {phase === "done" && result && (
          <>
            <p>
              {result.missing.length === 0
                ? "Everything checked is on disk."
                : `${result.missing.length.toLocaleString()} file${result.missing.length === 1 ? " is" : "s are"} really missing.`}{" "}
              To bring the extension in line with your drive:
            </p>
            <ol class="scan-steps">
              <li>
                <b>Save resync file</b> below.
              </li>
              <li>
                In the extension popup: <b>Sources → Import missing list…</b> and pick it. Files found here are
                marked as saved{result.missing.length > 0 && "; missing ones are queued"}.
              </li>
              {result.missing.length > 0 && (
                <li>
                  <b>Run → Download</b> fetches the missing ones to their usual paths.
                </li>
              )}
            </ol>
            <div class="modal-actions">
              {result.missing.length > 0 && (
                <button type="button" class="btn-ghost" onClick={onShowMissing}>
                  Show missing
                </button>
              )}
              <button type="button" class="btn-solid" onClick={saveList}>
                Save resync file
              </button>
              <button type="button" class="btn-ghost" onClick={start}>
                Scan again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
