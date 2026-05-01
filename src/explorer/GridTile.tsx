import { useState } from "preact/hooks";
import type { Bookmark, Media } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";

export interface MediaPair {
  b: Bookmark;
  m: Media;
}

export function GridTile({ pair, onClick }: { pair: MediaPair; onClick: () => void }) {
  const { b, m } = pair;
  const [missing, setMissing] = useState(false);
  const [fallback, setFallback] = useState(false);

  const safeUser = sanitizeUsername(b.username);
  const ext = m.kind === "video" ? "mp4" : (extFromUrl(m.url) ?? "jpg");
  const localPath = `media/${safeUser}/${b.id}_${m.index}.${ext}`;

  if (missing) {
    return (
      <div class="tile missing">
        <span>{m.kind === "video" ? "Video" : "Image"} missing</span>
      </div>
    );
  }

  return (
    <div class={`tile ${m.kind === "video" ? "video" : ""}`} onClick={onClick}>
      {m.kind === "video" ? (
        <video src={localPath} preload="metadata" muted playsInline onError={() => setMissing(true)} />
      ) : (
        <img
          src={fallback ? m.url : localPath}
          loading="lazy"
          alt=""
          onError={() => {
            if (fallback) setMissing(true);
            else setFallback(true);
          }}
        />
      )}
      <div class="overlay">@{b.username}</div>
    </div>
  );
}
