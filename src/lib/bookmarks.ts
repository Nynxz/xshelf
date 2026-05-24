import type { Bookmark, Captured, Media } from "./types";

// X's `Bookmarks` GraphQL operation expects a JSON `features` blob.
// Most flags here are inherited from the official web client.
const BOOKMARKS_FEATURES = {
  graphql_timeline_v2_bookmark_timeline: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

export interface FetchPageArgs {
  host: string;
  queryId: string;
  operation: string;
  cursor: string | null;
  captured: Captured;
}

export async function fetchBookmarksPage(args: FetchPageArgs): Promise<unknown> {
  const { host, queryId, operation, cursor, captured } = args;
  if (!captured.auth) throw new Error("No auth");

  const variables: Record<string, unknown> = { count: 100, includePromotedContent: false };
  if (cursor) variables.cursor = cursor;
  const url = new URL(`https://${host}/i/api/graphql/${queryId}/${operation}`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(BOOKMARKS_FEATURES));

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      authorization: captured.auth.authorization,
      "x-csrf-token": captured.auth.csrf,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bookmarks request failed: HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  return res.json();
}

export interface ExtractedPage {
  entries: unknown[];
  nextCursor: string | null;
}

export function extractEntries(json: unknown): ExtractedPage {
  // Defensively walk X's response shape.
  const j = json as { data?: { bookmark_timeline_v2?: { timeline?: { instructions?: unknown[] } } } };
  const instructions = j?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
  let entries: unknown[] = [];
  for (const ins of instructions as Array<{ type?: string; entries?: unknown[] }>) {
    if (ins.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      entries = entries.concat(ins.entries);
    }
  }
  let nextCursor: string | null = null;
  for (const e of entries as Array<{ content?: { entryType?: string; cursorType?: string; value?: string } }>) {
    const c = e?.content;
    if (c?.entryType === "TimelineTimelineCursor" && c?.cursorType === "Bottom") {
      nextCursor = c.value ?? null;
    }
  }
  const tweetEntries = (entries as Array<{ content?: { entryType?: string } }>).filter(
    (e) => e?.content?.entryType === "TimelineTimelineItem",
  );
  return { entries: tweetEntries, nextCursor };
}

interface ParsedTweet {
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
  media: Omit<Media, "downloaded">[];
}

export function parseTweetEntry(entry: unknown): ParsedTweet | null {
  try {
    const e = entry as { content?: { itemContent?: any } };
    const item = e?.content?.itemContent;
    if (!item || item.itemType !== "TimelineTweet") return null;
    const tr = item.tweet_results?.result;
    if (!tr) return null;
    const tweet = tr.__typename === "TweetWithVisibilityResults" ? tr.tweet : tr;
    if (!tweet?.legacy) return null;

    const legacy = tweet.legacy;
    const userResult = tweet.core?.user_results?.result;
    const userLegacy = userResult?.legacy;
    const username: string =
      userLegacy?.screen_name ?? userResult?.core?.screen_name ?? "unknown";
    const displayName: string = userLegacy?.name ?? userResult?.core?.name ?? "";

    const id: string = legacy.id_str || tweet.rest_id;
    const text: string =
      tweet.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? "";

    const media: Omit<Media, "downloaded">[] = [];
    const mediaArr: any[] =
      legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
    mediaArr.forEach((m, i) => {
      if (m.type === "photo") {
        media.push({ kind: "photo", index: i, url: toOrigPhoto(m.media_url_https) });
      } else if (m.type === "video" || m.type === "animated_gif") {
        const variants: Array<{ content_type: string; bitrate?: number; url: string }> =
          m.video_info?.variants ?? [];
        const mp4s = variants.filter(
          (v) => v.content_type === "video/mp4" && typeof v.bitrate === "number",
        );
        mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
        const best = mp4s[0] ?? variants[0];
        if (best?.url) media.push({ kind: "video", index: i, url: best.url });
      }
    });

    return {
      id,
      url: `https://x.com/${username}/status/${id}`,
      username,
      displayName,
      createdAt: legacy.created_at,
      text,
      lang: legacy.lang,
      replyCount: legacy.reply_count,
      retweetCount: legacy.retweet_count,
      favoriteCount: legacy.favorite_count,
      quoteCount: legacy.quote_count,
      media,
    };
  } catch {
    return null;
  }
}

export function toOrigPhoto(u: string): string {
  try {
    const url = new URL(u);
    const fmtMatch = url.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
    if (fmtMatch) {
      const fmt = fmtMatch[1].toLowerCase();
      const base = url.origin + url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, "");
      return `${base}?format=${fmt === "jpeg" ? "jpg" : fmt}&name=orig`;
    }
    url.searchParams.set("name", "orig");
    return url.toString();
  } catch {
    return u;
  }
}

export function extFromUrl(u: string): string | null {
  try {
    const url = new URL(u);
    const fmt = url.searchParams.get("format");
    if (fmt) return fmt;
    const m = url.pathname.match(/\.([a-z0-9]+)(?:$|\?)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function sanitizeUsername(s: string): string {
  return String(s || "unknown").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 60) || "unknown";
}

export function allMediaDownloaded(b: Bookmark): boolean {
  if (!b.media || b.media.length === 0) return true;
  return b.media.every((m) => m.downloaded);
}

/**
 * Call X's DeleteBookmark mutation for a single tweet. POST to
 * /i/api/graphql/{queryId}/DeleteBookmark with the tweet_id in the body.
 *
 * Returns true if X reports the bookmark was removed (HTTP 2xx with no
 * `errors` array, OR a 404 — which we treat as "already gone"). Throws with
 * the X error message on anything else.
 *
 * The queryId is captured opportunistically from the user's own page traffic
 * (see CAPTURED_OP_NAMES). X rotates it on releases — caller surfaces a
 * "remove one bookmark manually so we can capture the new queryId" hint when
 * capture is missing or stale.
 */
export type DeleteBookmarkResult = "removed" | "already-gone";

export async function deleteBookmark(
  tweetId: string,
  queryId: string,
  captured: Captured,
): Promise<DeleteBookmarkResult> {
  if (!captured.auth) throw new Error("No auth");
  const url = `https://x.com/i/api/graphql/${queryId}/DeleteBookmark`;
  const body = JSON.stringify({
    variables: { tweet_id: tweetId },
    queryId,
  });
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    referrer: "https://x.com/i/bookmarks",
    headers: {
      authorization: captured.auth.authorization,
      "x-csrf-token": captured.auth.csrf,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
      "content-type": "application/json",
      accept: "*/*",
    },
    body,
  });
  if (res.status === 404) {
    // X returns 404 if the bookmark didn't exist OR if the queryId rotated.
    // Distinguish via the body — "Query not found" means stale queryId.
    const text = await res.text().catch(() => "");
    if (/Query not found|queryId/i.test(text)) {
      throw new Error(
        `DeleteBookmark HTTP 404 — queryId rotated. Remove ONE bookmark manually on x.com so the new queryId can be captured. Body: ${text.slice(0, 200)}`,
      );
    }
    return "already-gone";
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`DeleteBookmark HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let j: { data?: unknown; errors?: Array<{ message?: string; code?: number }> } | null = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`DeleteBookmark non-JSON response: ${text.slice(0, 200)}`);
  }
  if (j?.errors?.length) {
    const e = j.errors[0];
    // Code 144 ("_Missing") means the bookmark isn't there anymore on X —
    // either the user removed it manually outside the extension, or X already
    // dropped it (deleted tweet, suspended author, etc.). Same end-state we
    // wanted, so report success. X's error text says "favorites" but that's
    // their internal store name for user-saved items; same code is used for
    // bookmarks. The `text` field on the throw path was preserved so the SW
    // can still log it as informational.
    if (e?.code === 144 || /_Missing/i.test(e?.message ?? "")) {
      return "already-gone";
    }
    throw new Error(
      `DeleteBookmark X error${e?.code != null ? ` (code ${e.code})` : ""}: ${e?.message || "unknown"}. Full: ${text.slice(0, 200)}`,
    );
  }
  // Liberal success check: any 2xx with no errors array counts. X has shipped
  // multiple data-shape variants for this mutation over the years.
  if (j?.data != null) return "removed";
  throw new Error(`DeleteBookmark unrecognised payload: ${text.slice(0, 200)}`);
}

export type { ParsedTweet };
