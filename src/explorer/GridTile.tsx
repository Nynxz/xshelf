import { useState } from "preact/hooks";
import type { Bookmark, Media } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { mediaPath } from "./util";
import { IconPlay } from "./icons";

export interface MediaPair {
  b: Bookmark;
  m: Media;
}

export function GridTile({ pair, onClick }: { pair: MediaPair; onClick: () => void }) {
  const { b, m } = pair;
  const [missing, setMissing] = useState(false);

  const safeUser = sanitizeUsername(b.username);
  const ext = m.kind === "video" ? "mp4" : (extFromUrl(m.url) ?? "jpg");
  const localPath = mediaPath(safeUser, b.id, m.index, ext);

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
        <img src={localPath} loading="lazy" alt="" onError={() => setMissing(true)} />
      )}
      {m.kind === "video" && (
        <span class="play-badge"><IconPlay size={11} /></span>
      )}
      <div class="overlay">@{b.username}</div>
    </div>
  );
}
