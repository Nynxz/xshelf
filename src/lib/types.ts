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

export interface Manifest {
  version: 1;
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
  folder: string;
  maxPages: number;
  incremental: boolean;
  /** Threshold of consecutive already-known tweets before we stop paginating. */
  earlyStopAfter?: number;
}

export interface Captured {
  auth: { authorization: string; csrf: string } | null;
  queryId: string | null;
  operation: string | null;
}

export interface CapturedSummary {
  hasAuth: boolean;
  queryId: string | null;
  operation: string | null;
}
