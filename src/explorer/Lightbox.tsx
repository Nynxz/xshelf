import { useEffect, useState } from "preact/hooks";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { fmtDate, fmtNum, linkify } from "./util";
import type { MediaPair } from "./GridTile";

interface LightboxProps {
  mediaList: MediaPair[];
  index: number;
  onClose: () => void;
  onNavigate: (i: number) => void;
}

export function Lightbox({ mediaList, index, onClose, onNavigate }: LightboxProps) {
  const [infoHidden, setInfoHidden] = useState(false);
  const pair = mediaList[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
      else if (e.key === "ArrowRight" && index < mediaList.length - 1) onNavigate(index + 1);
      else if (e.key === "i" || e.key === "I") setInfoHidden((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, mediaList.length, onClose, onNavigate]);

  if (!pair) return null;
  const { b, m } = pair;
  const safeUser = sanitizeUsername(b.username);
  const ext = m.kind === "video" ? "mp4" : (extFromUrl(m.url) ?? "jpg");
  const localPath = `media/${safeUser}/${b.id}_${m.index}.${ext}`;

  return (
    <div
      id="lightbox"
      class={`open ${infoHidden ? "info-hidden" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button id="lbClose" aria-label="close" onClick={onClose}>×</button>
      <button id="lbToggleInfo" title="Show/hide tweet text (i)" onClick={(e) => {
        e.stopPropagation();
        setInfoHidden((v) => !v);
      }}>i</button>
      <button id="lbPrev" aria-label="previous" disabled={index === 0} onClick={(e) => {
        e.stopPropagation();
        if (index > 0) onNavigate(index - 1);
      }}>‹</button>
      <button id="lbNext" aria-label="next" disabled={index === mediaList.length - 1} onClick={(e) => {
        e.stopPropagation();
        if (index < mediaList.length - 1) onNavigate(index + 1);
      }}>›</button>

      <div id="lbContent">
        <LightboxMedia mediaPath={localPath} kind={m.kind} fallbackUrl={m.url} />
      </div>

      <aside id="lbInfo">
        <div id="lbInfoHeader">
          <a id="lbUser" href={`https://x.com/${encodeURIComponent(b.username)}`} target="_blank" rel="noopener">
            {b.displayName} <span style={{ color: "rgba(255,255,255,0.55)", fontWeight: 400 }}>@{b.username}</span>
          </a>
          <a id="lbDate" href={b.url} target="_blank" rel="noopener">
            {fmtDate(b.createdAt)} · open tweet →
          </a>
        </div>
        {b.text ? (
          <div id="lbText" dangerouslySetInnerHTML={{ __html: linkify(b.text) }} />
        ) : (
          <div id="lbText"><em style={{ color: "rgba(255,255,255,0.4)" }}>(no text)</em></div>
        )}
        <div id="lbStats">
          <span>&#x1F4AC; {fmtNum(b.replyCount)}</span>
          <span>&#x1F501; {fmtNum(b.retweetCount)}</span>
          <span>&#x2764; {fmtNum(b.favoriteCount)}</span>
          <span>&#x1F4AC; {fmtNum(b.quoteCount)}</span>
        </div>
      </aside>
    </div>
  );
}

function LightboxMedia({
  mediaPath, kind, fallbackUrl,
}: {
  mediaPath: string; kind: "photo" | "video"; fallbackUrl: string;
}) {
  const [fallback, setFallback] = useState(false);
  if (kind === "video") {
    return (
      <video src={mediaPath} controls autoPlay playsInline />
    );
  }
  return (
    <img
      src={fallback ? fallbackUrl : mediaPath}
      alt=""
      onError={() => setFallback(true)}
    />
  );
}
