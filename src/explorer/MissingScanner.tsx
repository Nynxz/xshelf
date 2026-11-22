import { useState, useRef } from "preact/hooks";
import type { Bookmark, MediaKind, SourceKey } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { mediaPath } from "./util";

interface MissingItem {
  tweetId: string;
  username: string;
  mediaIndex: number;
  kind: MediaKind;
  url: string;
}

interface ScanResult {
  source: SourceKey;
  scannedAt: string;
  totalScanned: number;
  missingCount: number;
  items: MissingItem[];
}

/**
 * Probe a single local media path by asking the browser to load it. On file://
 * the browser's image/video loader IS the filesystem check — we don't have any
 * other API. Resolves true on successful load, false on error or timeout.
 */
function probe(path: string, kind: MediaKind): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => finish(true);
      v.onerror = () => finish(false);
      v.src = path;
    } else {
      const img = new Image();
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = path;
    }
    // Defensive timeout: file:// loads should complete in milliseconds; 8s
    // catches any case where neither event fires.
    setTimeout(() => finish(false), 8000);
  });
}

/**
 * "Find missing media" trigger + modal. Renders a button in the header that,
 * when clicked, opens a modal where the user can scan every media item in the
 * current source by trying to load it. The result downloads as a JSON file the
 * popup can re-ingest via Import missing list.
 *
 * Only enabled for a single source — the master "all sources" view doesn't
 * render this since it has no canonical source key to attach to results.
 */
export function MissingScanner({
  source,
  bookmarks,
}: {
  source: SourceKey;
  bookmarks: Bookmark[];
}) {
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [missingSoFar, setMissingSoFar] = useState(0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const cancelRef = useRef(false);

  const mediaTotal = bookmarks.reduce((n, b) => n + b.media.length, 0);

  function close(): void {
    if (scanning) return;
    setOpen(false);
    setResult(null);
    setDone(0);
    setMissingSoFar(0);
  }

  async function startScan(): Promise<void> {
    cancelRef.current = false;
    setScanning(true);
    setResult(null);
    setDone(0);
    setMissingSoFar(0);

    type Probe = MissingItem & { path: string };
    const probes: Probe[] = [];
    for (const b of bookmarks) {
      for (const m of b.media) {
        const safeUser = sanitizeUsername(b.username);
        const ext = m.kind === "video" ? "mp4" : (extFromUrl(m.url) ?? "jpg");
        probes.push({
          tweetId: b.id,
          username: b.username,
          mediaIndex: m.index,
          kind: m.kind,
          url: m.url,
          path: mediaPath(safeUser, b.id, m.index, ext),
        });
      }
    }
    setTotal(probes.length);

    const missing: MissingItem[] = [];
    const CONCURRENCY = 8;
    let next = 0;
    let completed = 0;

    async function worker(): Promise<void> {
      while (!cancelRef.current) {
        const i = next++;
        if (i >= probes.length) return;
        const p = probes[i];
        const ok = await probe(p.path, p.kind);
        if (!ok) {
          missing.push({
            tweetId: p.tweetId,
            username: p.username,
            mediaIndex: p.mediaIndex,
            kind: p.kind,
            url: p.url,
          });
        }
        completed++;
        if (completed % 20 === 0 || completed === probes.length) {
          setDone(completed);
          setMissingSoFar(missing.length);
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, probes.length) },
      () => worker(),
    );
    await Promise.all(workers);
    setDone(probes.length);
    setMissingSoFar(missing.length);

    if (!cancelRef.current) {
      setResult({
        source,
        scannedAt: new Date().toISOString(),
        totalScanned: probes.length,
        missingCount: missing.length,
        items: missing,
      });
    }
    setScanning(false);
  }

  function downloadResult(): void {
    if (!result) return;
    const payload = { schema: "xshelf-missing-list/1", ...result };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = result.scannedAt.replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z");
    a.href = url;
    a.download = `${source.replace(":", "-")}-missing-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <button
        class="missing-scan-trigger"
        title="Scan disk for missing media in this source"
        onClick={() => setOpen(true)}
        disabled={mediaTotal === 0}
      >
        Find missing
      </button>
      {open && (
        <div
          class="missing-modal-backdrop"
          onClick={() => !scanning && close()}
          role="dialog"
          aria-modal="true"
        >
          <div class="missing-modal" onClick={(e: MouseEvent) => e.stopPropagation()}>
            <div class="missing-modal-head">
              <h2>Find missing media</h2>
              <button
                class="icon-close"
                onClick={close}
                disabled={scanning}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p class="muted">
              Asks the browser to load every media file in this source and reports
              which ones it couldn't open. Read-only — no files are modified.
            </p>

            {!scanning && !result && (
              <div class="missing-actions">
                <button class="primary" onClick={startScan}>
                  Scan {mediaTotal} media item{mediaTotal === 1 ? "" : "s"}
                </button>
                <button onClick={close}>Cancel</button>
              </div>
            )}

            {scanning && (
              <>
                <div class="missing-progress">
                  <div class="bar" style={{ width: `${pct}%` }} />
                </div>
                <p class="muted">
                  {done} / {total} checked · {missingSoFar} missing so far
                </p>
                <div class="missing-actions">
                  <button onClick={() => { cancelRef.current = true; }}>Cancel</button>
                </div>
              </>
            )}

            {result && (
              <>
                <p class="missing-summary">
                  <strong>{result.missingCount}</strong> of {result.totalScanned}{" "}
                  media item{result.totalScanned === 1 ? "" : "s"} missing on disk.
                </p>
                {result.missingCount > 0 ? (
                  <>
                    <p class="muted">
                      Download the list, then open the extension popup → <em>Sources</em>{" "}
                      → <em>Import missing list</em> to queue them for redownload.
                    </p>
                    <div class="missing-actions">
                      <button class="primary" onClick={downloadResult}>
                        Download list ({result.missingCount} items)
                      </button>
                      <button onClick={close}>Close</button>
                    </div>
                  </>
                ) : (
                  <div class="missing-actions">
                    <button onClick={close}>Close</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
