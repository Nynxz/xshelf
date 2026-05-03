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
  | "interrupted";

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
export type CapturedOpName = "Bookmarks" | "UserByScreenName" | "UserTweets" | "UserMedia";

export const CAPTURED_OP_NAMES: ReadonlyArray<CapturedOpName> = [
  "Bookmarks",
  "UserByScreenName",
  "UserTweets",
  "UserMedia",
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
}
