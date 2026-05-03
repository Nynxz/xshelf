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

export async function fetchUserTweetsPage(args: FetchUserTweetsArgs): Promise<unknown> {
  const { userId, queryId, cursor, captured, host = "x.com" } = args;
  if (!captured.auth) throw new Error("No auth");
  const variables: Record<string, unknown> = {
    userId,
    count: 40,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: true,
    withV2Timeline: true,
  };
  if (cursor) variables.cursor = cursor;
  const url = new URL(`https://${host}/i/api/graphql/${queryId}/UserTweets`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(USER_TWEETS_FEATURES));

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
    throw new Error(`UserTweets failed: HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  return res.json();
}

export interface ExtractedUserPage {
  entries: unknown[];
  nextCursor: string | null;
}

export function extractUserTweetsEntries(json: unknown): ExtractedUserPage {
  // Defensively walk the shape: data.user.result.timeline.timeline.instructions[]
  const j = json as { data?: { user?: { result?: { timeline?: { timeline?: { instructions?: unknown[] } } } } } };
  const instructions = j?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  let entries: unknown[] = [];
  for (const ins of instructions as Array<{ type?: string; entries?: unknown[]; entry?: unknown }>) {
    if (ins.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      entries = entries.concat(ins.entries);
    } else if (ins.type === "TimelinePinEntry" && ins.entry) {
      // Pinned tweet — include it but downstream filtering will treat it normally.
      entries.push(ins.entry);
    }
  }
  let nextCursor: string | null = null;
  for (const e of entries as Array<{ content?: { entryType?: string; cursorType?: string; value?: string } }>) {
    const c = e?.content;
    if (c?.entryType === "TimelineTimelineCursor" && c?.cursorType === "Bottom") {
      nextCursor = c.value ?? null;
    }
  }
  // Filter to tweet-bearing entries (skip cursors, modules with conversation we don't expand).
  const tweetEntries = (entries as Array<{ content?: { entryType?: string; itemContent?: any; items?: any[] } }>).filter((e) => {
    const c = e?.content;
    return c?.entryType === "TimelineTimelineItem" || c?.entryType === "TimelineTimelineModule";
  });
  return { entries: tweetEntries, nextCursor };
}

/**
 * Heuristic: a retweet has `legacy.retweeted_status_result` (or
 * `legacy.retweeted_status`) set on the tweet object. Original posts don't.
 */
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
