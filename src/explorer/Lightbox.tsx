import { useEffect, useState } from "preact/hooks";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { fmtDate, fmtNum, linkify, mediaPath } from "./util";
import type { MediaPair } from "./GridTile";
import { IconClose, IconChevronLeft, IconChevronRight, IconInfo, IconExternal, IconReply, IconRetweet, IconHeart, IconQuote } from "./icons";

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
  const localPath = mediaPath(safeUser, b.id, m.index, ext);

  return (
    <div
      id="lightbox"
      class={`open ${infoHidden ? "info-hidden" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button id="lbClose" aria-label="Close" onClick={onClose}><IconClose size={20} /></button>
      <button id="lbToggleInfo" title="Toggle tweet text (i)" aria-label="Toggle tweet text" onClick={(e) => {
        e.stopPropagation();
        setInfoHidden((v) => !v);
      }}><IconInfo size={18} /></button>
      <button id="lbPrev" aria-label="Previous" disabled={index === 0} onClick={(e) => {
        e.stopPropagation();
        if (index > 0) onNavigate(index - 1);
      }}><IconChevronLeft size={22} /></button>
      <button id="lbNext" aria-label="Next" disabled={index === mediaList.length - 1} onClick={(e) => {
        e.stopPropagation();
        if (index < mediaList.length - 1) onNavigate(index + 1);
      }}><IconChevronRight size={22} /></button>

      <div id="lbContent">
        <LightboxMedia mediaPath={localPath} kind={m.kind} />
      </div>

      <aside id="lbInfo">
        <div id="lbInfoHeader">
          <a id="lbUser" href={`https://x.com/${encodeURIComponent(b.username)}`} target="_blank" rel="noopener">
            {b.displayName} <span style={{ color: "rgba(255,255,255,0.55)", fontWeight: 400 }}>@{b.username}</span>
          </a>
          <a id="lbDate" href={b.url} target="_blank" rel="noopener">
            {fmtDate(b.createdAt)} <IconExternal size={12} /> open tweet
          </a>
        </div>
        {b.text ? (
          <div id="lbText" dangerouslySetInnerHTML={{ __html: linkify(b.text) }} />
        ) : (
          <div id="lbText"><em style={{ color: "rgba(255,255,255,0.4)" }}>(no text)</em></div>
        )}
        <div id="lbStats">
          <span><IconReply size={14} /> {fmtNum(b.replyCount)}</span>
          <span><IconRetweet size={14} /> {fmtNum(b.retweetCount)}</span>
          <span><IconHeart size={14} /> {fmtNum(b.favoriteCount)}</span>
          <span><IconQuote size={14} /> {fmtNum(b.quoteCount)}</span>
        </div>
      </aside>
    </div>
  );
}

function LightboxMedia({
  mediaPath, kind,
}: {
  mediaPath: string; kind: "photo" | "video";
}) {
  // Offline-only: no remote fallback. If the file isn't on disk, show a placeholder.
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <div style={{ color: "rgba(255,255,255,0.7)", padding: 24 }}>{kind === "video" ? "Video" : "Image"} not available offline</div>;
  }
  if (kind === "video") {
    return (
      <video src={mediaPath} controls autoPlay playsInline onError={() => setMissing(true)} />
    );
  }
  return (
    <img src={mediaPath} alt="" onError={() => setMissing(true)} />
  );
}
