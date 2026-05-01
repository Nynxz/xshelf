import { useState } from "preact/hooks";
import type { Bookmark, Media } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { fmtDate, fmtNum, linkify } from "./util";

export function BookmarkCard({ bookmark }: { bookmark: Bookmark }) {
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
            <MediaItem key={m.index} bookmark={bookmark} media={m} />
          ))}
        </div>
      )}
      <div class="stats">
        <span>&#x1F4AC; {fmtNum(bookmark.replyCount)}</span>
        <span>&#x1F501; {fmtNum(bookmark.retweetCount)}</span>
        <span>&#x2764; {fmtNum(bookmark.favoriteCount)}</span>
        <span>&#x1F4AC; {fmtNum(bookmark.quoteCount)}</span>
      </div>
    </article>
  );
}

function MediaItem({ bookmark, media }: { bookmark: Bookmark; media: Media }) {
  const safeUser = sanitizeUsername(bookmark.username);
  const ext = media.kind === "video" ? "mp4" : (extFromUrl(media.url) ?? "jpg");
  const localPath = `media/${safeUser}/${bookmark.id}_${media.index}.${ext}`;
  const [missing, setMissing] = useState(false);
  const [fallback, setFallback] = useState(false);

  if (missing) {
    return <div class="missing">{media.kind === "video" ? "Video" : "Image"} not on disk — open original tweet</div>;
  }

  if (media.kind === "video") {
    return (
      <div class="video-wrap">
        <video src={localPath} controls preload="metadata" playsInline onError={() => setMissing(true)} />
      </div>
    );
  }

  return (
    <a href={fallback ? media.url : localPath} target="_blank" rel="noopener">
      <img
        src={fallback ? media.url : localPath}
        loading="lazy"
        alt=""
        onError={() => {
          if (fallback) setMissing(true);
          else setFallback(true);
        }}
      />
    </a>
  );
}
