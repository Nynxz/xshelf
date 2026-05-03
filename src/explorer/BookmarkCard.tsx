import { useState } from "preact/hooks";
import type { Bookmark, Media } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { fmtDate, fmtNum, linkify } from "./util";
import { IconReply, IconRetweet, IconHeart, IconQuote } from "./icons";

export function BookmarkCard({
  bookmark,
  onOpenLightbox,
}: {
  bookmark: Bookmark;
  onOpenLightbox: (bookmarkId: string, mediaIndex: number) => void;
}) {
  return (
    <article class="card">
      <div class="card-header">
        <div class="user">
          <a href={`https://x.com/${encodeURIComponent(bookmark.username)}`} target="_blank" rel="noopener">
            <span class="display">{bookmark.displayName}</span>
            <span class="handle">@{bookmark.username}</span>
          </a>
        </div>
        <a class="date" href={bookmark.url} target="_blank" rel="noopener">
          {fmtDate(bookmark.createdAt)}
        </a>
      </div>
      {bookmark.text && (
        <div class="text" dangerouslySetInnerHTML={{ __html: linkify(bookmark.text) }} />
      )}
      {bookmark.media.length > 0 && (
        <div class="media">
          {bookmark.media.map((m) => (
            <MediaItem
              key={m.index}
              bookmark={bookmark}
              media={m}
              onOpen={() => onOpenLightbox(bookmark.id, m.index)}
            />
          ))}
        </div>
      )}
      <div class="stats">
        <span><IconReply size={14} /> {fmtNum(bookmark.replyCount)}</span>
        <span><IconRetweet size={14} /> {fmtNum(bookmark.retweetCount)}</span>
        <span><IconHeart size={14} /> {fmtNum(bookmark.favoriteCount)}</span>
        <span><IconQuote size={14} /> {fmtNum(bookmark.quoteCount)}</span>
      </div>
    </article>
  );
}

function MediaItem({
  bookmark,
  media,
  onOpen,
}: {
  bookmark: Bookmark;
  media: Media;
  onOpen: () => void;
}) {
  const safeUser = sanitizeUsername(bookmark.username);
  const ext = media.kind === "video" ? "mp4" : (extFromUrl(media.url) ?? "jpg");
  const localPath = `media/${safeUser}/${bookmark.id}_${media.index}.${ext}`;
  const [missing, setMissing] = useState(false);

  // Strictly offline: never auto-fetch from pbs.twimg.com / video.twimg.com.
  // The tweet URL is just a click-through hyperlink, not an automatic request.
  if (missing) {
    return (
      <a class="missing" href={bookmark.url} target="_blank" rel="noopener">
        {media.kind === "video" ? "Video" : "Image"} not on disk — open tweet
      </a>
    );
  }

  if (media.kind === "video") {
    return (
      <div class="video-wrap">
        <video src={localPath} controls preload="metadata" playsInline onError={() => setMissing(true)} />
      </div>
    );
  }

  // Click on a photo opens the shared lightbox. Lets the user navigate
  // adjacent media with arrow keys and close with Esc, instead of opening
  // a separate browser tab they'd have to back out of.
  return (
    <button class="media-btn" type="button" onClick={onOpen} aria-label="View image">
      <img src={localPath} loading="lazy" alt="" onError={() => setMissing(true)} />
    </button>
  );
}
