import type {
  CapturedSummary,
  Manifest,
  RuntimeState,
  SourceKey,
  SyncOptions,
  UnbookmarkOptions,
  UnbookmarkReport,
  VerifyReport,
} from "./types";

/**
 * The full set of typed messages the popup/explorer can send to the background.
 * Discriminated by `type`; each shape has its own response type.
 */
export type RequestMessage =
  | { type: "getRunState" }
  | { type: "getManifest"; source?: import("./types").SourceKey }
  | { type: "startSync"; options: SyncOptions }
  | { type: "startDownload" }
  | { type: "discardPending" }
  | { type: "cancelBackup" }
  | { type: "clearManifest"; source?: import("./types").SourceKey }
  | { type: "listSources" }
  | { type: "wipeAll" }
  /**
   * Cross-check a source's manifest against Chrome's download history to find
   * media items that should be on disk but aren't. With `dryRun: true` returns
   * the report only; with `dryRun: false` also flips manifest flags + enqueues
   * the missing items into the pending list (status becomes "ready").
   */
  | { type: "verifySource"; source: import("./types").SourceKey; folder: string; dryRun: boolean }
  /**
   * Ingest a missing-list JSON exported from the explorer's "Find missing
   * media" scanner. The explorer's check is browser-level (`<img onerror>`)
   * so it sees actual filesystem state, unlike verifySource which queries
   * Chrome's download history. Items get pushed onto the pending queue and
   * the user can then "Download all" on the Run tab.
   */
  | {
      type: "importMissingList";
      source: import("./types").SourceKey;
      folder: string;
      items: Array<{
        tweetId: string;
        username: string;
        mediaIndex: number;
        kind: "photo" | "video";
        url: string;
        /** Per-item sources (missing-list v2); falls back to `source`. */
        sources?: import("./types").SourceKey[];
      }>;
      /**
       * Disk-scan list v2 only: items the scan found ON disk, as
       * [tweetId, mediaIndex, sources]. Their `downloaded` flags are set true,
       * so the import resyncs flags in both directions.
       */
      present?: Array<[string, number, import("./types").SourceKey[]]>;
    }
  /**
   * Cleanup: remove bookmarks from the user's X account in batches.
   * `dryRun: true` returns the preview list only — no writes to X.
   * `dryRun: false` performs the deletes with paced requests and marks
   * each unbookmarked item in the local manifest with `unbookmarkedAt`.
   *
   * Always writes a backup of the bookmarks manifest to disk first when
   * `dryRun: false`, so even a buggy run leaves the user with a recoverable
   * archive.
   */
  | { type: "unbookmark"; options: UnbookmarkOptions; folder: string }
  /** Write the bookmarks manifest as JSON to <folder>/backups/bookmarks-<iso>.json. */
  | { type: "backupManifest"; folder: string }
  /**
   * Rewrite xshelf/index.html + classic.html without syncing, to pick up a
   * newer explorer build. Per-source data.js files are left as they are.
   */
  | { type: "rebuildExplorer"; folder: string }
  /**
   * Wipe the cleanup tombstone store. The next cleanup crawl will not filter
   * any tweet by past-handled state (manifest's own unbookmarkedAt stamps
   * still apply within their TTL). Use when you've re-bookmarked items that
   * cleanup is still skipping.
   */
  | { type: "clearCleanupHistory" };

export type ResponseFor<T extends RequestMessage["type"]> =
  T extends "getRunState"
    ? { ok: true; version: string; state: RuntimeState; captured: CapturedSummary }
    : T extends "getManifest"
      ? { ok: true; manifest: Manifest }
      : T extends "listSources"
        ? { ok: true; sources: SourceKey[] } | { ok: false; error: string }
        : T extends "verifySource"
          ? { ok: true; report: VerifyReport } | { ok: false; error: string }
          : T extends "importMissingList"
            ? { ok: true; queued: number; skipped: number; reconciled: number } | { ok: false; error: string }
            : T extends "unbookmark"
              ? { ok: true; report: UnbookmarkReport } | { ok: false; error: string }
              : T extends "backupManifest"
                ? { ok: true; path: string } | { ok: false; error: string }
                : { ok: true } | { ok: false; error: string };

/** Server-pushed events */
export type BroadcastMessage =
  | { type: "stateUpdate"; state: RuntimeState };

export const SW_VERSION = "v46-media-filters";

export function send<T extends RequestMessage>(
  msg: T,
): Promise<ResponseFor<T["type"]>> {
  return chrome.runtime.sendMessage(msg) as Promise<ResponseFor<T["type"]>>;
}
