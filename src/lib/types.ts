export type MediaKind = "photo" | "video";

/**
 * X split the profile Media tab into filtered sub-views (circa 2026-08):
 *   /<handle>/media                → the unfiltered ("default") view
 *   /<handle>/media?filter=photo   → photos only
 * Each view drives its own GraphQL request and returns its own timeline, so
 * one crawl of the default view no longer yields the full media archive. A
 * "variant" is just the `?filter=` value (or "default" when there is none) —
 * deliberately an open string so a filter X adds or renames next week is
 * captured and crawled the moment the user visits it, with no code change.
 *
 * The *operation name* moved too: the single `UserMedia` operation became
 * per-view operations (`UserPhotoTimeline`, and by the same pattern
 * `UserVideoTimeline`). Nothing below keys off the name — see
 * `isMediaTimelineCandidate`.
 */
export type MediaVariant = string;

export const DEFAULT_MEDIA_VARIANT: MediaVariant = "default";

/**
 * The views we actively tell the user to capture. Anything beyond this is
 * still captured and crawled if they happen to visit it; this list only drives
 * the "you haven't captured X yet" nudges, so keep it to views X is known to
 * serve — nagging about a view that doesn't exist is worse than silence.
 */
export const KNOWN_MEDIA_VARIANTS: ReadonlyArray<MediaVariant> = [
  DEFAULT_MEDIA_VARIANT,
  "photo",
] as const;

/** Human label for a media variant, e.g. for popup banners and run-log lines. */
export function mediaVariantLabel(v: MediaVariant): string {
  if (v === DEFAULT_MEDIA_VARIANT) return "default view";
  if (v === "photo") return "photos";
  if (v === "video") return "videos";
  return `${v} view`;
}

/** Path + query for a variant's page on x.com (no leading host). */
export function mediaVariantPath(handle: string, v: MediaVariant): string {
  return v === DEFAULT_MEDIA_VARIANT
    ? `/${handle}/media`
    : `/${handle}/media?filter=${v}`;
}

/**
 * Map a `?filter=` query value from a /<handle>/media URL onto a variant key.
 * Absent / empty → the default (unfiltered) view.
 */
export function mediaVariantFromFilter(
  filter: string | null | undefined,
): MediaVariant {
  const f = (filter ?? "").trim().toLowerCase();
  return f === "" ? DEFAULT_MEDIA_VARIANT : f;
}

/**
 * Operations that show up on a profile Media tab but are NOT the media grid.
 * Without this, the structural test below would happily capture a prefetched
 * main-timeline request and crawl it as though it were the media view.
 */
const NON_MEDIA_TIMELINE_OPS: ReadonlySet<string> = new Set([
  "UserTweets",
  "UserTweetsAndReplies",
  "UserHighlightsTweets",
  "UserArticlesTweets",
  "UserByScreenName",
  "UserByRestId",
  "Likes",
  "Followers",
  "Following",
  "TweetDetail",
  "Bookmarks",
  "ProfileSpotlightsQuery",
]);

/**
 * Name-based guess: does this operation look like a profile media timeline?
 * X replaced the single `UserMedia` operation with per-view operations
 * (`UserPhotoTimeline`, and by the same pattern `UserVideoTimeline`), so we
 * match the media word rather than an exact name. Only used for requests we
 * CAN'T attribute to a Media tab; attributable ones go through
 * `isMediaTimelineVariables` and needn't match a name at all.
 */
export function looksLikeMediaTimelineOp(op: string): boolean {
  if (NON_MEDIA_TIMELINE_OPS.has(op)) return false;
  return /^user[a-z]*(media|photo|video|image|gif)[a-z]*$/i.test(op);
}

/**
 * Structural test for "this GraphQL GET paginates one user's timeline": it
 * addresses a user by id and asks for a page of a given size. Paired with
 * "the request came from /<handle>/media", this catches a media view whose
 * operation X renames to something we've never seen.
 */
export function isMediaTimelineVariables(v: Record<string, unknown>): boolean {
  const id = v.userId;
  const hasUser =
    typeof id === "string" ? id.length > 0 : typeof id === "number";
  return hasUser && typeof v.count === "number";
}

/**
 * Should we even consider storing this GraphQL request as a media-view
 * template? Cheap synchronous pre-filter for the webRequest listener — the
 * real decision (which variant, or drop it) needs the page URL, which is only
 * available asynchronously.
 */
export function isMediaTimelineCandidate(
  op: string,
  variables: Record<string, unknown> | undefined,
): boolean {
  if (NON_MEDIA_TIMELINE_OPS.has(op)) return false;
  if (looksLikeMediaTimelineOp(op)) return true;
  return !!variables && isMediaTimelineVariables(variables);
}

/**
 * Captured variants in crawl order: the default view first, then filtered
 * views alphabetically, so run logs are stable between syncs.
 */
export function sortMediaVariants(variants: MediaVariant[]): MediaVariant[] {
  return [...variants].sort((a, b) => {
    if (a === b) return 0;
    if (a === DEFAULT_MEDIA_VARIANT) return -1;
    if (b === DEFAULT_MEDIA_VARIANT) return 1;
    return a.localeCompare(b);
  });
}

export interface Media {
  kind: MediaKind;
  index: number;
  url: string;
  /** True when we've successfully written the file to disk via chrome.downloads. */
  downloaded: boolean;
  /** Original pixel size from X's `original_info`, when known (recorded since 0.3). */
  width?: number;
  height?: number;
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
  /** True when the crawl stopped short of the end of the timeline. */
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
  /**
   * True when the crawl did NOT reach the end of the timeline: an early stop on
   * known items, the page budget running out, a cancelled run, or a view that
   * errored. A `false` here is what makes `contentHash` comparable between two
   * archives of the same handle — a truncated crawl only hashes a prefix.
   */
  stoppedEarly: boolean;
}

export interface PendingMediaItem {
  tweetId: string;
  username: string;
  mediaIndex: number;
  kind: MediaKind;
  url: string;
  /**
   * Manifests whose `downloaded` flag this item updates. Absent = the run's
   * own source (runtime.options.source). Set by a cross-source missing-list
   * import, since the media tree is shared between sources.
   */
  sources?: SourceKey[];
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
  /** When the check finished (ISO). */
  checkedAt?: string;
  /**
   * Download-history entries for this folder's media recorded under OTHER
   * directories (e.g. before the download folder moved), largest first.
   */
  elsewhere?: Array<{ dir: string; count: number }>;
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
   * Crawl the whole timeline: never stop on a run of already-known tweets, and
   * ignore the per-sync page cap (a hard ceiling still applies). Known items
   * are still skipped, so a full scan downloads only what's missing.
   *
   * This is the mode for an archive whose known items are *interleaved* with
   * unseen ones — some posts saved by hand, or by an earlier partial run —
   * where the consecutive-known heuristic bails in the middle of the timeline
   * and leaves everything older than that run unarchived.
   */
  fullScan?: boolean;
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
  | "DeleteBookmark"
  | "CreateBookmark";

export const CAPTURED_OP_NAMES: ReadonlyArray<CapturedOpName> = [
  "Bookmarks",
  "UserByScreenName",
  "UserTweets",
  "UserMedia",
  "DeleteBookmark",
  "CreateBookmark",
] as const;

/**
 * A verbatim record of a GraphQL GET the user's browser actually made, so we
 * can replay it with only `userId` / `cursor` substituted. Capturing the real
 * `variables` blob is what lets us follow X's media-tab filters without
 * knowing the name or shape of the flag they added this week.
 */
export interface CapturedGraphQLRequest {
  queryId: string;
  /**
   * Operation name exactly as it appeared in the request path — `UserMedia`
   * on older captures, `UserPhotoTimeline` and friends on current ones.
   * Replayed verbatim; never reconstructed.
   */
  operation: string;
  variables: Record<string, unknown>;
  features?: Record<string, unknown>;
  fieldToggles?: Record<string, unknown>;
  /** ISO timestamp of capture — shown in the popup so stale captures are obvious. */
  capturedAt: string;
  /** The x.com page URL that issued it, for diagnostics. */
  pageUrl?: string;
}

export interface Captured {
  auth: { authorization: string; csrf: string } | null;
  /** Endpoint metadata keyed by GraphQL operation name. queryId rotates with X releases. */
  endpoints: Partial<Record<CapturedOpName, { queryId: string }>>;
  /**
   * Real media-timeline requests, one per media sub-view (`/media`,
   * `/media?filter=photo`, …). Keyed by variant because X returns a different
   * timeline per view; replaying the captured request is the only reliable way
   * to reach a view whose filter flag — or whose operation name — we don't
   * know. Entries carry their own `operation`, so a view served by
   * `UserPhotoTimeline` and one served by `UserMedia` coexist here happily.
   */
  userMedia?: Record<MediaVariant, CapturedGraphQLRequest>;
  /**
   * Latest queryId seen for each media-timeline operation name, independent of
   * which view issued it. queryIds rotate with every X release while the
   * captured `variables` stay valid for much longer, so a crawl prefers the
   * freshest queryId for its template's operation over the one frozen into the
   * template. Not in `endpoints` because that map is keyed by a closed union
   * and these names are whatever X ships next.
   */
  mediaOps?: Record<string, { queryId: string; seenAt: string }>;
  /**
   * Full JSON body captured from a real /DeleteBookmark POST that the user's
   * browser made. Used as a template — when WE call DeleteBookmark, we copy
   * this object and substitute tweet_id into variables. X has been adding
   * fields to bookmark mutations (folder IDs, feature flags) as they ship
   * Bookmark Folders; hardcoding a "variables: { tweet_id }, queryId" body
   * works for some accounts and silently routes to an empty bookmark store
   * for others (returns code 144 "_Missing" for items that ARE bookmarked).
   * Capturing the real body sidesteps all of that.
   */
  deleteBookmarkBody?: Record<string, unknown> | null;
  /**
   * Same trick for CreateBookmark — needed for the ghost-fix flow. When
   * X's bookmarks LIST API returns items that DeleteBookmark says aren't
   * actually bookmarked, we re-add them (CreateBookmark) then re-remove
   * (DeleteBookmark) to force both stores into agreement.
   */
  createBookmarkBody?: Record<string, unknown> | null;
  /**
   * Exact request URLs the user's browser sent for the bookmark mutations.
   * Reconstructing the URL from a queryId is fragile — X's web client may use
   * slightly different paths or include query parameters we don't know about.
   * Replaying the captured URL guarantees we hit whatever X is actually serving.
   */
  deleteBookmarkUrl?: string | null;
  createBookmarkUrl?: string | null;
  /**
   * All headers we observed on the real browser request, lower-cased. Used to
   * pass through anti-abuse / fingerprint headers like x-client-uuid and
   * x-client-transaction-id that X requires on bookmark mutations. Captured
   * via onSendHeaders (which sees them post-browser-augmentation) rather than
   * onBeforeRequest (which doesn't).
   */
  deleteBookmarkHeaders?: Record<string, string> | null;
  createBookmarkHeaders?: Record<string, string> | null;
}

export interface CapturedSummary {
  hasAuth: boolean;
  hasBookmarks: boolean;
  hasUserByScreenName: boolean;
  hasUserTweets: boolean;
  hasUserMedia: boolean;
  /** Media sub-views we have a replayable request for. */
  userMediaVariants: MediaVariant[];
  /**
   * Distinct GraphQL operation names behind those views (e.g.
   * `UserPhotoTimeline`). Surfaced so a rename on X's side is visible in the
   * popup instead of showing up as a mysteriously empty crawl.
   */
  userMediaOps: string[];
  hasDeleteBookmark: boolean;
  hasCreateBookmark: boolean;
  /** True when we have a real captured POST body template for DeleteBookmark. */
  hasDeleteBookmarkBody: boolean;
  hasCreateBookmarkBody: boolean;
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
  /**
   * When DeleteBookmark returns "_Missing" / code 144 (X's bookmarks list
   * returned the item but the bookmark store disagrees — "ghost bookmark"),
   * attempt to fix the inconsistency by calling CreateBookmark and then
   * DeleteBookmark again. Requires CreateBookmark capture. Off by default
   * because it's a write operation the user must opt into.
   */
  fixGhosts?: boolean;
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
  /**
   * Live-run only (and only when fixGhosts is on) — items that initially
   * returned "_Missing" but were successfully cleared by the CreateBookmark
   * + DeleteBookmark dance. End state is the same as `removed`: the item is
   * no longer on the user's account or in their bookmarks list.
   */
  ghostsFixed: string[];
  /** Live-run only — items that failed (network error, HTTP error, etc.). */
  failed: Array<{ id: string; error: string }>;
  /** Total bookmarks remaining locally that are NOT marked unbookmarkedAt. */
  remainingAfter: number;
}
