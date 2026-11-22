import { useMemo, useRef } from "preact/hooks";
import type { MutableRef } from "preact/hooks";
import { linkify } from "../explorer/util";
import { fmtDate, fmtNum, handleHue, sourceLabel, type Post } from "./data";
import { IExternal, IHeart, IReply, IRepost } from "./icons";
import { Thumb } from "./Thumb";
import { docTop, useMeasured, useVirtualRange } from "./virtual";

const GAP = 16;

/** Readable one-column timeline of posts, virtualized with measured heights. */
export function FeedView({
  posts,
  onOpen,
  onUser,
  revealRef,
}: {
  posts: Post[];
  onOpen: (key: string) => void;
  onUser: (username: string) => void;
  revealRef: MutableRef<((key: string) => void) | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => posts.map((p) => p.b.id), [posts]);
  const { offsets, observe } = useMeasured(
    ref,
    keys,
    (i) => {
      const p = posts[i];
      return 120 + Math.ceil((p.b.text?.length ?? 0) / 70) * 26 + (p.media.length ? 380 : 0);
    },
    GAP,
  );
  const range = useVirtualRange(ref, offsets, 1600);

  revealRef.current = (key: string) => {
    const id = key.split("_")[0];
    const idx = posts.findIndex((p) => p.b.id === id);
    if (idx < 0) return;
    const top = docTop(ref.current) + offsets[idx];
    const bottom = top + (offsets[idx + 1] - offsets[idx]);
    if (top < window.scrollY + 120 || bottom > window.scrollY + window.innerHeight) {
      window.scrollTo(0, Math.max(0, top - 140));
    }
  };

  if (posts.length === 0) {
    return (
      <div ref={ref} class="empty">
        Nothing matches these filters.
      </div>
    );
  }

  return (
    <div ref={ref} class="feed">
      <div style={{ height: range.padTop }} />
      {posts.slice(range.start, range.end).map((p) => (
        <div key={p.b.id} data-vkey={p.b.id} ref={observe} class="feed-slot">
          <PostCard post={p} onOpen={onOpen} onUser={onUser} />
        </div>
      ))}
      <div style={{ height: range.padBottom }} />
    </div>
  );
}

export function Avatar({ username, displayName, size = 40 }: { username: string; displayName: string; size?: number }) {
  const hue = handleHue(username);
  return (
    <span
      class="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 32% 42%)` }}
    >
      {(displayName || username || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

function PostCard({
  post,
  onOpen,
  onUser,
}: {
  post: Post;
  onOpen: (key: string) => void;
  onUser: (username: string) => void;
}) {
  const b = post.b;
  const n = post.media.length;
  return (
    <article class="post">
      <header class="post-head">
        <Avatar username={b.username} displayName={b.displayName} />
        <div class="post-who">
          <button type="button" class="link-btn post-name" onClick={() => onUser(b.username)}>
            {b.displayName || b.username}
          </button>
          <span class="muted">
            @{b.username} · {fmtDate(post.postedAt)}
          </span>
        </div>
        <a class="icon-link" href={b.url} target="_blank" rel="noopener" aria-label="Open post on X">
          <IExternal size={16} />
        </a>
      </header>
      {b.text && <div class="post-text" dangerouslySetInnerHTML={{ __html: linkify(b.text) }} />}
      {n > 0 && (
        <div class={`post-media ${n === 1 ? "single" : "multi"}${n === 3 ? " three" : ""}`}>
          {post.media.map((item, i) => (
            <button
              type="button"
              class="post-media-item"
              key={item.key}
              onClick={() => onOpen(item.key)}
              aria-label={`Open ${item.m.kind} ${i + 1} of ${n}`}
            >
              <Thumb item={item} fit={n === 1 ? "natural" : "cover"} />
            </button>
          ))}
        </div>
      )}
      <footer class="post-foot">
        <span title="Likes">
          <IHeart size={14} /> {fmtNum(b.favoriteCount)}
        </span>
        <span title="Reposts">
          <IRepost size={14} /> {fmtNum(b.retweetCount)}
        </span>
        <span title="Replies">
          <IReply size={14} /> {fmtNum(b.replyCount)}
        </span>
        <span class="post-saved">
          {post.sources.map(sourceLabel).join(" · ")} · saved {fmtDate(post.bookmarkedAt)}
        </span>
      </footer>
    </article>
  );
}
