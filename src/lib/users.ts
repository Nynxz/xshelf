import type { Captured } from "./types";

// Features blob inferred from current X web requests; tweaks-tolerant.
const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const USER_BY_SCREEN_NAME_FIELD_TOGGLES = {
  withAuxiliaryUserLabels: false,
};

const USER_TWEETS_FEATURES = {
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

export interface UserProfile {
  rest_id: string;
  screen_name: string;
  name: string;
}

export async function fetchUserByScreenName(
  handle: string,
  queryId: string,
  captured: Captured,
  host = "x.com",
): Promise<UserProfile> {
  if (!captured.auth) throw new Error("No auth");
  const variables = { screen_name: handle, withSafetyModeUserFields: true };
  const url = new URL(`https://${host}/i/api/graphql/${queryId}/UserByScreenName`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(USER_BY_SCREEN_NAME_FEATURES));
  url.searchParams.set("fieldToggles", JSON.stringify(USER_BY_SCREEN_NAME_FIELD_TOGGLES));

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
    throw new Error(`UserByScreenName failed: HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: { user?: { result?: any } } };
  const result = json?.data?.user?.result;
  if (!result || !result.rest_id) {
    throw new Error(`User @${handle} not found (or not visible to your account).`);
  }
  return {
    rest_id: String(result.rest_id),
    screen_name: result.legacy?.screen_name ?? handle,
    name: result.legacy?.name ?? "",
  };
}

export interface FetchUserTweetsArgs {
  userId: string;
  queryId: string;
  cursor: string | null;
  captured: Captured;
  host?: string;
}

async function fetchUserGraphQLPage(
  operation: "UserTweets" | "UserMedia",
  args: FetchUserTweetsArgs,
): Promise<unknown> {
  const { userId, queryId, cursor, captured, host = "x.com" } = args;
  if (!captured.auth) throw new Error("No auth");
  // Variable shape mirrors what x.com's web client sends. Some of these flags
  // (withClientEventToken, withBirdwatchNotes) are tolerated for the initial
  // request but cause cursor-based follow-ups to return empty pages if missing.
  const variables: Record<string, unknown> = {
    userId,
    count: 20,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
    withV2Timeline: true,
  };
  if (cursor) variables.cursor = cursor;
  const url = new URL(`https://${host}/i/api/graphql/${queryId}/${operation}`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(USER_TWEETS_FEATURES));
  // X's web client also sends a fieldToggles param; some queryId rotations
  // require it for cursor-based pagination to return new content.
  url.searchParams.set("fieldToggles", JSON.stringify({ withArticlePlainText: false }));

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
    throw new Error(`${operation} failed: HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  return res.json();
}

export function fetchUserTweetsPage(args: FetchUserTweetsArgs): Promise<unknown> {
  return fetchUserGraphQLPage("UserTweets", args);
}

export function fetchUserMediaPage(args: FetchUserTweetsArgs): Promise<unknown> {
  return fetchUserGraphQLPage("UserMedia", args);
}

export interface ExtractedUserPage {
  entries: unknown[];
  nextCursor: string | null;
  /**
   * Set when X's bottom cursor entry carries `stopOnEmptyResponse: true`,
   * meaning "if you got nothing on this page, stop following the cursor."
   * Without this, X will happily hand out pagination cursors forever.
   */
  stopOnEmptyResponse?: boolean;
  /** Diagnostic counts for the run-log: helps tell extractor bugs from parser bugs. */
  raw?: { items: number; modules: number; cursors: number; other: number };
}

export function extractUserTweetsEntries(json: unknown): ExtractedUserPage {
  // Walks the timeline instructions and returns a flattened list of *tweet-shaped
  // entries*. Module-wrapped tweets (the /<user>/media grid uses
  // TimelineTimelineModule with items[] arrays) are unwrapped into synthetic
  // TimelineTimelineItem entries so parseTweetEntry (which reads
  // content.itemContent) handles both layouts uniformly.
  //
  // X's response shape varies across endpoints / queryId rotations; we try
  // every path we've seen in the wild.
  const j = json as {
    data?: {
      user?: {
        result?: {
          timeline?: { timeline?: { instructions?: unknown[] }; instructions?: unknown[] };
          timeline_v2?: { timeline?: { instructions?: unknown[] }; instructions?: unknown[] };
        };
      };
    };
  };
  const result = j?.data?.user?.result;
  const root = result?.timeline_v2 ?? result?.timeline;
  const instructions =
    root?.timeline?.instructions ??
    root?.instructions ??
    [];

  const flat: unknown[] = [];
  let nextCursor: string | null = null;
  let stopOnEmptyResponse = false;
  const raw = { items: 0, modules: 0, cursors: 0, other: 0 };

  type AnyEntry = {
    content?: {
      entryType?: string;
      cursorType?: string;
      value?: string;
      stopOnEmptyResponse?: boolean;
      itemContent?: unknown;
      items?: Array<{ item?: { itemContent?: unknown } }>;
    };
    entryId?: string;
  };

  function consume(entry: AnyEntry): void {
    const c = entry?.content;
    if (!c) {
      raw.other++;
      return;
    }
    if (c.entryType === "TimelineTimelineCursor") {
      raw.cursors++;
      if (c.cursorType === "Bottom" && c.value) {
        nextCursor = c.value;
        if (c.stopOnEmptyResponse) stopOnEmptyResponse = true;
      }
      return;
    }
    if (c.entryType === "TimelineTimelineItem") {
      raw.items++;
      flat.push(entry);
      return;
    }
    if (c.entryType === "TimelineTimelineModule" && Array.isArray(c.items)) {
      raw.modules++;
      for (const mi of c.items) {
        const itemContent = mi?.item?.itemContent;
        if (!itemContent) continue;
        // Re-wrap as a TimelineTimelineItem-shaped entry. parseTweetEntry only
        // looks at content.itemContent, so this is enough.
        flat.push({ content: { entryType: "TimelineTimelineItem", itemContent } });
      }
      return;
    }
    raw.other++;
  }

  for (const ins of instructions as Array<{ type?: string; entries?: AnyEntry[]; entry?: AnyEntry }>) {
    if (ins.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      for (const e of ins.entries) consume(e);
    } else if (ins.type === "TimelinePinEntry" && ins.entry) {
      consume(ins.entry);
    }
  }

  return { entries: flat, nextCursor, raw, stopOnEmptyResponse };
}

/**
 * Heuristic: a retweet has `legacy.retweeted_status_result` (or
 * `legacy.retweeted_status`) set on the tweet object. Original posts don't.
 */
/**
 * SHA-256 of the newline-joined, lexicographically-sorted tweet IDs.
 * Two archives that contain exactly the same tweets produce the same hash;
 * if they differ, the difference is precisely the symmetric difference of
 * their id-sets — which the diff UI (phase 3) can show.
 */
export async function computeContentHash(tweetIds: string[]): Promise<string> {
  const sorted = [...tweetIds].sort();
  const text = sorted.join("\n");
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function isRetweet(entry: unknown): boolean {
  try {
    const e = entry as { content?: any };
    const item = e?.content?.itemContent;
    if (!item || item.itemType !== "TimelineTweet") return false;
    const tr = item.tweet_results?.result;
    if (!tr) return false;
    const tweet = tr.__typename === "TweetWithVisibilityResults" ? tr.tweet : tr;
    if (!tweet?.legacy) return false;
    return !!(tweet.legacy.retweeted_status_result || tweet.legacy.retweeted_status);
  } catch {
    return false;
  }
}
