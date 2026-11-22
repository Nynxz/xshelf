import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { linkify } from "../explorer/util";
import { fmtDate, fmtNum, sourceLabel, type MediaItem } from "./data";
import { Avatar } from "./FeedView";
import { IClose, IExternal, ILeft, IPanelRight, IRight, IWall, IWarn, IZoomIn, IZoomOut } from "./icons";
import { LightboxThumbnails } from "./LightboxThumbnails";

const MAX_ZOOM = 8;

interface View {
  s: number;
  x: number;
  y: number;
}
const FIT: View = { s: 1, x: 0, y: 0 };

/**
 * Full-screen viewer over the current filtered media list.
 * Keys: ←/→ move, Esc closes, i toggles info, z zooms, space plays
 * video, Home/End jump. Wheel/pinch-zoom, drag to pan when zoomed, swipe
 * left/right to move and down to close on touch.
 */
export function Lightbox({
  items,
  index,
  onNavigate,
  onClose,
  onUser,
}: {
  items: MediaItem[];
  index: number;
  onNavigate: (i: number) => void;
  onClose: () => void;
  onUser: (username: string) => void;
}) {
  const item = items[index];
  const [info, setInfo] = useState(() => {
    try {
      return localStorage.getItem("xshelf-lb-info") !== "0";
    } catch {
      return true;
    }
  });
  const [view, setView] = useState<View>(FIT);
  const [showThumbnails, setShowThumbnails] = useState(() => window.innerWidth > 900);
  const [missing, setMissing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const go = (i: number) => {
    if (i >= 0 && i < items.length && i !== index) onNavigate(i);
  };

  useLayoutEffect(() => {
    try {
      localStorage.setItem("xshelf-lb-info", info ? "1" : "0");
    } catch {
      // per-viewer convenience only
    }
  }, [info]);

  // Reset zoom + missing state per item; preload neighbours.
  useLayoutEffect(() => {
    setView(FIT);
    setMissing(false);
    for (const d of [1, -1, 2]) {
      const n = items[index + d];
      if (n && n.m.kind === "photo") new Image().src = n.path;
    }
  }, [index, items]);

  // Lock page scroll + manage focus while open.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    document.documentElement.classList.add("lb-open");
    closeRef.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    return () => {
      document.documentElement.classList.remove("lb-open");
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === "Escape") onClose();
      else if (k === "ArrowRight") go(index + 1);
      else if (k === "ArrowLeft") go(index - 1);
      else if (k === "Home") go(0);
      else if (k === "End") go(items.length - 1);
      else if (k.toLowerCase() === "i") setInfo((v) => !v);
      else if (k === "z") setView((v) => (v.s > 1 ? FIT : { s: 2.5, x: 0, y: 0 }));
      else if (k === " " && videoRef.current) {
        const v = videoRef.current;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- zoom & pan ---------------------------------------------------------
  const zoomAt = (clientX: number, clientY: number, nextScale: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const cx = clientX - (r.left + r.width / 2);
    const style = getComputedStyle(stage);
    const offsetY = (parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / 2;
    const cy = clientY - (r.top + r.height / 2 + offsetY);
    setView((v) => {
      const s = Math.min(MAX_ZOOM, Math.max(1, nextScale));
      if (s === 1) return FIT;
      const ux = (cx - v.x) / v.s;
      const uy = (cy - v.y) / v.s;
      return { s, x: cx - ux * s, y: cy - uy * s };
    });
  };

  const onWheel = (e: WheelEvent) => {
    if (item.m.kind !== "photo" || missing) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, view.s * Math.exp(-e.deltaY * 0.0018));
  };

  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number; t: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Element;
    if (target.closest("button, a, video")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, t: Date.now() };
    target.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || view.s === 1) return;
    setView({ s: view.s, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) });
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || view.s !== 1) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const fast = Date.now() - d.t < 600;
    if (fast && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(index + (dx < 0 ? 1 : -1));
    else if (fast && dy > 90 && e.pointerType !== "mouse") onClose();
  };

  if (!item) return null;
  const b = item.post.b;
  const postMedia = item.post.media;
  const thumbnailsOpen = showThumbnails && items.length > 1;

  return (
    <div class="lb" role="dialog" aria-modal="true" aria-label="Media viewer">
      <div class={`lb-main${view.s > 1 ? " lb-main-zoomed" : ""}${thumbnailsOpen ? " lb-main-with-thumbnails" : ""}`}>
        <div class="lb-bar">
          <div class="lb-bar-start">
            <button ref={closeRef} type="button" class="lb-btn" onClick={onClose} aria-label="Close (Esc)">
              <IClose />
            </button>
            {items.length > 1 && (
              <button
                type="button"
                class="lb-btn"
                aria-label="Thumbnails"
                aria-expanded={showThumbnails}
                aria-controls={showThumbnails ? "lb-thumbnails" : undefined}
                title={showThumbnails ? "Hide thumbnails" : "Show thumbnails"}
                onClick={() => setShowThumbnails((v) => !v)}
              >
                <IWall />
              </button>
            )}
          </div>
          <span class="lb-count">
            {index + 1} / {items.length}
            {postMedia.length > 1 && (
              <span class="muted">
                {" "}
                · {postMedia.findIndex((m) => m.key === item.key) + 1} of {postMedia.length} in post
              </span>
            )}
          </span>
          <span class="lb-spacer" />
          {item.m.kind === "photo" && !missing && (
            <button
              type="button"
              class="lb-btn"
              onClick={() => setView((v) => (v.s > 1 ? FIT : { s: 2.5, x: 0, y: 0 }))}
              aria-label={view.s > 1 ? "Fit to screen (z)" : "Zoom in (z)"}
            >
              {view.s > 1 ? <IZoomOut /> : <IZoomIn />}
            </button>
          )}
          <button
            type="button"
            class="lb-btn lb-details"
            aria-label="Details"
            aria-expanded={info}
            aria-controls="lb-details-panel"
            onClick={() => setInfo((v) => !v)}
            title={info ? "Hide details (I)" : "Show details (I)"}
          >
            <IPanelRight /> <span>Details</span>
          </button>
        </div>

        <div class="lb-viewer">
          {thumbnailsOpen && <LightboxThumbnails items={items} index={index} onNavigate={go} />}
          <div class="lb-canvas">
            <button type="button" class="lb-nav lb-prev" disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous (←)">
              <ILeft size={18} />
            </button>
            <div
              ref={stageRef}
              class={`lb-stage ${view.s > 1 ? "is-zoomed" : ""}`}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { drag.current = null; }}
              onDblClick={(e) => {
                if (item.m.kind !== "photo" || missing) return;
                if (view.s > 1) setView(FIT);
                else if ((e.target as Element).matches("img.lb-media")) zoomAt(e.clientX, e.clientY, 2.5);
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget && view.s === 1) onClose();
              }}
            >
              {missing ? (
                <div class="lb-missing">
                  <IWarn size={28} />
                  <p>This {item.m.kind} isn't on disk.</p>
                  <a href={b.url} target="_blank" rel="noopener">
                    Open the post on X
                  </a>
                </div>
              ) : item.m.kind === "video" ? (
                <video
                  key={item.key}
                  ref={videoRef}
                  class="lb-media"
                  src={item.path}
                  controls
                  autoPlay
                  playsInline
                  onError={() => setMissing(true)}
                />
              ) : (
                <img
                  key={item.key}
                  class="lb-media"
                  src={item.path}
                  alt=""
                  draggable={false}
                  style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
                  onError={() => setMissing(true)}
                />
              )}
            </div>
            <button
              type="button"
              class="lb-nav lb-next"
              disabled={index === items.length - 1}
              onClick={() => go(index + 1)}
              aria-label="Next (→)"
            >
              <IRight size={18} />
            </button>
          </div>
        </div>
      </div>

      <aside id="lb-details-panel" class="lb-info" aria-label="Post details" hidden={!info}>
        <div class="lb-who">
          <Avatar username={b.username} displayName={b.displayName} size={40} />
          <div>
            <div class="lb-name">{b.displayName || b.username}</div>
            <div class="muted">@{b.username}</div>
          </div>
        </div>
        {b.text ? (
          <div class="lb-text" dangerouslySetInnerHTML={{ __html: linkify(b.text) }} />
        ) : (
          <div class="lb-text muted">No text</div>
        )}
        {postMedia.length > 1 && (
          <div class="lb-post-media">
            {postMedia.map((pm, j) => {
              const target = items.findIndex((x) => x.key === pm.key);
              return (
                <button
                  type="button"
                  key={pm.key}
                  class="lb-post-thumb"
                  aria-current={pm.key === item.key ? "true" : undefined}
                  disabled={target < 0}
                  onClick={() => go(target)}
                  aria-label={`Item ${j + 1} of this post`}
                >
                  {pm.m.kind === "video" ? <span class="lb-post-video">▶</span> : <img src={pm.path} alt="" loading="lazy" />}
                </button>
              );
            })}
          </div>
        )}
        <div class="lb-stats">
          <span>{fmtNum(b.favoriteCount)} likes</span>
          <span>{fmtNum(b.retweetCount)} reposts</span>
          <span>{fmtNum(b.replyCount)} replies</span>
        </div>
        <dl class="lb-meta">
          <div>
            <dt>Posted</dt>
            <dd>{fmtDate(item.post.postedAt)}</dd>
          </div>
          <div>
            <dt>Saved</dt>
            <dd>{fmtDate(item.post.bookmarkedAt)}</dd>
          </div>
          <div>
            <dt>Sources</dt>
            <dd>{item.post.sources.map(sourceLabel).join(", ")}</dd>
          </div>
          <div>
            <dt>File</dt>
            <dd class="mono">{item.path.replace(/^.*?media\//, "media/")}</dd>
          </div>
        </dl>
        <div class="lb-actions">
          <a class="btn btn-primary" href={b.url} target="_blank" rel="noopener">
            <IExternal size={16} /> Open post on X
          </a>
          <button type="button" class="btn" onClick={() => onUser(b.username)}>
            More from @{b.username}
          </button>
        </div>
        <p class="lb-keys muted">← → move · z zoom · i details · Esc close</p>
      </aside>
    </div>
  );
}
