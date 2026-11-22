import { useState } from "preact/hooks";
import { learnAspect, type MediaItem } from "./data";
import { IPlay, IWarn } from "./icons";

/**
 * `fit`: "cover" fills the box (crops unless the box has the media's own
 * shape), "contain" letterboxes inside the box, "natural" sizes the box from
 * the media itself (no crop, height follows width).
 */
export type Fit = "cover" | "contain" | "natural";

/**
 * One media tile. Strictly offline: only ever loads the local file; when it
 * isn't on disk we show a placeholder instead of reaching out to X's CDN.
 */
export function Thumb({
  item,
  fit = "cover",
  hoverPlay = false,
  videoFrame = false,
}: {
  item: MediaItem;
  fit?: Fit;
  hoverPlay?: boolean;
  videoFrame?: boolean;
}) {
  const [missing, setMissing] = useState(false);
  const isVideo = item.m.kind === "video";

  if (missing) {
    return (
      <span class={`thumb is-${fit} thumb-missing`}>
        <IWarn size={18} />
        <span>Not on disk</span>
      </span>
    );
  }

  return (
    <span class={`thumb is-${fit}`}>
      {isVideo ? (
        <video
          src={videoFrame ? `${item.path}#t=0.1` : item.path}
          preload="metadata"
          muted
          playsInline
          loop
          onLoadedMetadata={(e) => {
            const v = e.currentTarget as HTMLVideoElement;
            learnAspect(item.key, v.videoWidth, v.videoHeight);
          }}
          onMouseEnter={hoverPlay ? (e) => (e.currentTarget as HTMLVideoElement).play().catch(() => {}) : undefined}
          onMouseLeave={hoverPlay ? (e) => (e.currentTarget as HTMLVideoElement).pause() : undefined}
          onError={() => setMissing(true)}
        />
      ) : (
        <img
          src={item.path}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            learnAspect(item.key, img.naturalWidth, img.naturalHeight);
          }}
          onError={() => setMissing(true)}
        />
      )}
      {isVideo && (
        <span class="thumb-badge">
          <IPlay size={11} />
          Video
        </span>
      )}
    </span>
  );
}
