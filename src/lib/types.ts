export type MediaKind = "photo" | "video";

export interface Media {
  kind: MediaKind;
  index: number;
  url: string;
  /** True when we've successfully written the file to disk via chrome.downloads. */
  downloaded: boolean;
}

export interface Bookmark {
  id: string;
  url: string;
  username: string;
  displayName: string;
  createdAt?: string;
  text: string;
  lang?: string;
  replyCount?: number;
  retweetCount?: number;
  favoriteCount?: number;
  quoteCount?: number;
  media: Media[];
  /** ISO timestamp of the very first time we encountered this bookmark. */
  firstSeenAt: string;
  /**
   * ISO timestamp of the most recent sync that visited this bookmark.
   * SAME value for every bookmark visited within a single sync.
   * Combined with `lastSeenIndex` this is the sort key for "newest bookmarked".
   */
  lastSeenAt: string;
  /** Position within the most-recent sync's encounter order (1 = newest in that sync). */
  lastSeenIndex: number;
  /**
   * If set, the user removed this bookmark from their X account via the
   * extension's Cleanup tab at this timestamp. The local manifest entry
   * stays (it's the archive); only the bookmark on X is gone. Future syncs
   * skip removed items so we never accidentally try to delete them twice.
   */
  unbookmarkedAt?: string;
}

/**
 * A source is one of:
 *   - "bookmarks" — your own bookmark feed (the only kind in phase 0)
 *   - "user:<handle>" — another user's archived posts (added in phase 1)
 *
 * The user-archive variant carries the @handle in the key so multiple users can
 * coexist in storage and on disk.
 */
export type SourceKey = "bookmarks" | `user:${string}`;

export function userSource(handle: string): SourceKey {
  return `user:${handle.toLowerCase()}` as SourceKey;
}

export function isUserSource(s: SourceKey): s is `user:${string}` {
  return s.startsWith("user:");
}

export function sourceUsername(s: SourceKey): string | null {
  return isUserSource(s) ? s.slice("user:".length) : null;
}

/** Folder segment for this source on disk (e.g. "bookmarks" or "users/elonmusk"). */
export function sourceDiskPath(s: SourceKey): string {
  if (s === "bookmarks") return "bookmarks";
  const user = sourceUsername(s);
  return `users/${user}`;
}

export interface Manifest {
  version: 2;
  source: SourceKey;
  bookmarks: Record<string, Bookmark>;
  lastRun: LastRun | null;
}

export interface LastRun {
  finishedAt: string;
  pages: number;
  seen: number;
  newCount: number;
  stoppedEarly: boolean;
  phase: "sync" | "download";
}

/**
 * Per-crawl manifest written for user-archive sources only. Lives at
 * `<folder>/users/<handle>/crawls/<iso>.json` and is the unit of comparison
 * between two users who've each archived the same handle.
 */
export interface CrawlManifest {
  version: 1;
  source: SourceKey;
  username: string;
  crawledAt: string;          // ISO of when this run finished
  tweetCount: number;
  tweetIdMin: string | null;  // numeric strings, but compared lexicographically since they're sortable as such
  tweetIdMax: string | null;
  /** sha256 hex over `\n`-joined sorted tweet ids — `<min>` ≤ `<max>` */
  contentHash: string;
  pages: number;
  stoppedEarly: boolean;
}

export interface PendingMediaItem {
  tweetId: string;
  username: string;
  mediaIndex: number;
  kind: MediaKind;
  url: string;
}

export interface PendingByUserEntry {
  count: number;
  photos: number;
  videos: number;
}

export interface PendingSummary {
  count: number;
  tweetCount: number;
  photoCount: number;
  videoCount: number;
  byUser: Record<string, PendingByUserEntry>;
}

export type RunStatus =
  | "idle"
  | "syncing"
  | "ready"
  | "downloading"
  | "cancelling"
  | "cancelled"
  | "done"
  | "error"
  | "interrupted"
  | "verifying"
  | "unbookmarking";

/**
 * Result of a verify pass: cross-checks every media item in a source's manifest
 * against Chrome's download history. Read-only — never modifies disk; the caller
 * decides whether to enqueue the missing items for download.
 */
export interface VerifyReport {
  source: SourceKey;
  folder: string;
  /** Total media items inspected (sum of media[] across all bookmarks in source). */
  totalMedia: number;
  /** Items confirmed present (Chrome reports a complete download at the expected path). */
  presentCount: number;
  /** Items that should be on disk but aren't — these are the candidates to re-download. */
  missingCount: number;
  /** Items the manifest claimed weren't downloaded but actually ARE on disk (will be reconciled). */
  reconcilableCount: number;
  /** Per-author breakdown of missing items, mirroring PendingSummary.byUser shape. */
  byUser: Record<string, { missing: number; photos: number; videos: number }>;
  /** Sample of missing items (capped) for the UI to show specific examples. */
  sample: Array<{ tweetId: string; username: string; mediaIndex: number; kind: MediaKind }>;
}

export interface RuntimeState {
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  currentPhase: string | null;
  options: SyncOptions | null;
  pageCount: number;
  totalSeen: number;
  newCount: number;
  totalKnown: number;
  mediaTotal: number;
  mediaDone: number;
  mediaSkipped: number;
  mediaErrored: number;
  errorMessage: string | null;
  pendingSummary: PendingSummary;
  log: string[];
}

export interface SyncOptions {
  /** Which source to sync. "bookmarks" or "user:<handle>". */
  source: SourceKey;
  folder: string;
  maxPages: number;
  incremental: boolean;
  /** Threshold of consecutive already-known tweets before we stop paginating. */
  earlyStopAfter?: number;
  /**
   * For user-archive sources: which endpoint to paginate.
   *  - "media" (default) → UserMedia (only media-bearing tweets, faster)
   *  - "tweets" → UserTweets (all originals incl. text-only; filters retweets)
   * Ignored for the bookmarks source.
   */
  userMode?: "media" | "tweets";
}

/** GraphQL operations we care about capturing from the page. */
export type CapturedOpName =
  | "Bookmarks"
  | "UserByScreenName"
  | "UserTweets"
  | "UserMedia"
  | "DeleteBookmark";

export const CAPTURED_OP_NAMES: ReadonlyArray<CapturedOpName> = [
  "Bookmarks",
  "UserByScreenName",
  "UserTweets",
  "UserMedia",
  "DeleteBookmark",
] as const;

export interface Captured {
  auth: { authorization: string; csrf: string } | null;
  /** Endpoint metadata keyed by GraphQL operation name. queryId rotates with X releases. */
  endpoints: Partial<Record<CapturedOpName, { queryId: string }>>;
}

export interface CapturedSummary {
  hasAuth: boolean;
  hasBookmarks: boolean;
  hasUserByScreenName: boolean;
  hasUserTweets: boolean;
  hasUserMedia: boolean;
  hasDeleteBookmark: boolean;
}

/**
 * How to pick which bookmarks to unbookmark when the user runs Cleanup.
 * Sort + filter + cap, all client-side from the local manifest. The actual
 * unbookmark call only happens on bookmarks that match.
 */
export interface UnbookmarkOptions {
  /** Source must be "bookmarks" — DeleteBookmark only applies to your own bookmarks. */
  source: "bookmarks";
  /**
   * Ordering of the candidate list. The first `count` items get unbookmarked.
   *  - "oldest-bookmarked-first" → (lastSeenAt ASC, lastSeenIndex DESC)
   *  - "newest-bookmarked-first" → (lastSeenAt DESC, lastSeenIndex ASC)
   *  - "oldest-tweet-first"      → (createdAt ASC)
   *  - "newest-tweet-first"      → (createdAt DESC)
   */
  order:
    | "oldest-bookmarked-first"
    | "newest-bookmarked-first"
    | "oldest-tweet-first"
    | "newest-tweet-first";
  /** Optional @username filter (case-insensitive, no @). */
  usernameFilter?: string;
  /** Max items to unbookmark in this batch. Capped at 1000 server-side to be safe. */
  count: number;
  /** If true, don't actually call DeleteBookmark — just return the preview list. */
  dryRun: boolean;
}

export interface UnbookmarkPreviewEntry {
  id: string;
  username: string;
  displayName: string;
  createdAt?: string;
  text: string;
  /** Only set when the candidate came from the local manifest (legacy mode). */
  lastSeenAt?: string;
}

export interface UnbookmarkReport {
  /** What we *would* unbookmark (dry run) or *did* unbookmark (live). */
  preview: UnbookmarkPreviewEntry[];
  /** Live-run only — bookmarks X actively removed in this run. */
  removed: string[];
  /**
   * Live-run only — bookmarks X reported as "already gone" (code 144 /
   * _Missing). The local manifest was stale; same end state as removed, so
   * we still stamp `unbookmarkedAt` and skip them next time.
   */
  alreadyGone: string[];
  /** Live-run only — items that failed (network error, HTTP error, etc.). */
  failed: Array<{ id: string; error: string }>;
  /** Total bookmarks remaining locally that are NOT marked unbookmarkedAt. */
  remainingAfter: number;
}
