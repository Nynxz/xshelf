import { useEffect, useMemo, useState, useCallback } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Bookmark } from "../lib/types";
import {
  Header,
  type SortKey,
  type ViewMode,
  type MediaFilter,
  type ImageFit,
  type DisplaySize,
} from "./Header";
import { BookmarkCard } from "./BookmarkCard";
import { GridTile, type MediaPair } from "./GridTile";
import { Lightbox } from "./Lightbox";

const PAGE_SIZE = 50;
const GRID_PAGE_SIZE = 200;

const SIZE_PRESETS: Record<DisplaySize, { gridMin: string; rowHeight: string }> = {
  small: { gridMin: "120px", rowHeight: "160px" },
  medium: { gridMin: "180px", rowHeight: "220px" },
  large: { gridMin: "260px", rowHeight: "300px" },
};

interface Props {
  bookmarks: Bookmark[];
  lastRunFinishedAt: string | null;
  /** Optional content rendered to the LEFT of the main pane (used by master view's sidebar). */
  sidebar?: ComponentChildren;
  /** Optional content rendered before the search field in the toolbar. */
  headerLeft?: ComponentChildren;
}

/**
 * The full filter / sort / list-grid / lightbox UI given a single Bookmark[].
 * Shared by:
 *   - App.tsx (per-source explorer; one source's data inlined as JSON)
 *   - MasterApp.tsx (master explorer; multiple sources, currently-selected
 *     source's bookmarks passed in)
 */
export function BookmarkExplorer({ bookmarks, lastRunFinishedAt, sidebar, headerLeft }: Props) {
  const [view, setView] = useState<ViewMode>("list");
  const [sortBy, setSortBy] = useState<SortKey>("bookmarked-desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("");
  const [renderedCount, setRenderedCount] = useState(PAGE_SIZE);
  const [lbIndex, setLbIndex] = useState(-1);

  const [imageFit, setImageFit] = useState<ImageFit>(() => {
    try { return (localStorage.getItem("xbd-image-fit") as ImageFit) || "contain"; } catch { return "contain"; }
  });
  const [size, setSize] = useState<DisplaySize>(() => {
    try { return (localStorage.getItem("xbd-display-size") as DisplaySize) || "medium"; } catch { return "medium"; }
  });

  useEffect(() => {
    document.documentElement.style.setProperty("--media-fit", imageFit);
    try { localStorage.setItem("xbd-image-fit", imageFit); } catch {}
  }, [imageFit]);
  useEffect(() => {
    const preset = SIZE_PRESETS[size];
    document.documentElement.style.setProperty("--grid-min", preset.gridMin);
    document.documentElement.style.setProperty("--media-row-height", preset.rowHeight);
    try { localStorage.setItem("xbd-display-size", size); } catch {}
  }, [size]);

  const userCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of bookmarks) counts[b.username] = (counts[b.username] ?? 0) + 1;
    return counts;
  }, [bookmarks]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim().replace(/^@/, "");
    return bookmarks
      .filter((b) => {
        if (userFilter && b.username !== userFilter) return false;
        const hasMedia = b.media.length > 0;
        const hasPhoto = hasMedia && b.media.some((m) => m.kind !== "video");
        const hasVideo = hasMedia && b.media.some((m) => m.kind === "video");
        if (mediaFilter === "photo" && !hasPhoto) return false;
        if (mediaFilter === "video" && !hasVideo) return false;
        if (mediaFilter === "any" && !hasMedia) return false;
        if (mediaFilter === "none" && hasMedia) return false;
        if (q) {
          const blob = `${b.text} ${b.username} ${b.displayName}`.toLowerCase();
          if (!blob.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => compareBy(a, b, sortBy));
  }, [bookmarks, searchQuery, userFilter, mediaFilter, sortBy]);

  // Reset pagination + lightbox when the underlying data set changes (e.g. user
  // switches source in the master view) or when filters change.
  useEffect(() => {
    setRenderedCount(view === "grid" ? GRID_PAGE_SIZE : PAGE_SIZE);
    setLbIndex(-1);
  }, [bookmarks, searchQuery, userFilter, mediaFilter, sortBy, view]);

  const mediaList = useMemo<MediaPair[]>(() => {
    const list: MediaPair[] = [];
    for (const b of filtered) {
      for (const m of b.media) list.push({ b, m });
    }
    return list;
  }, [filtered]);

  const mediaIndexLookup = useMemo(() => {
    const map = new Map<string, number>();
    mediaList.forEach((p, i) => map.set(`${p.b.id}_${p.m.index}`, i));
    return map;
  }, [mediaList]);

  const openLightboxFor = useCallback((bookmarkId: string, mediaIndex: number) => {
    const idx = mediaIndexLookup.get(`${bookmarkId}_${mediaIndex}`);
    if (idx != null) setLbIndex(idx);
  }, [mediaIndexLookup]);

  const items = view === "grid" ? mediaList : filtered;
  const visible = items.slice(0, renderedCount);
  const onCloseLightbox = useCallback(() => setLbIndex(-1), []);

  const explorerBody = (
    <>
      <Header
        count={items.length}
        total={bookmarks.length}
        userCounts={userCounts}
        view={view} setView={setView}
        sortBy={sortBy} setSortBy={setSortBy}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        userFilter={userFilter} setUserFilter={setUserFilter}
        mediaFilter={mediaFilter} setMediaFilter={setMediaFilter}
        imageFit={imageFit} setImageFit={setImageFit}
        size={size} setSize={setSize}
        lastRunFinishedAt={lastRunFinishedAt}
        leadingContent={headerLeft}
      />
      <main class={view === "grid" ? "view-grid" : ""}>
        {visible.length === 0 ? (
          <div class="empty">{view === "grid" ? "No media matches." : "Nothing matches."}</div>
        ) : view === "grid" ? (
          (visible as MediaPair[]).map((pair, i) => (
            <GridTile key={`${pair.b.id}_${pair.m.index}`} pair={pair} onClick={() => setLbIndex(i)} />
          ))
        ) : (
          (visible as Bookmark[]).map((b) => (
            <BookmarkCard key={b.id} bookmark={b} onOpenLightbox={openLightboxFor} />
          ))
        )}
        {renderedCount < items.length && (
          <button
            class="load-more"
            onClick={() =>
              setRenderedCount((n) => n + (view === "grid" ? GRID_PAGE_SIZE : PAGE_SIZE))
            }
          >
            Load more ({items.length - renderedCount} remaining)
          </button>
        )}
      </main>
      {lbIndex >= 0 && (
        <Lightbox
          mediaList={mediaList}
          index={lbIndex}
          onClose={onCloseLightbox}
          onNavigate={setLbIndex}
        />
      )}
    </>
  );

  if (sidebar) {
    return (
      <div class="master-layout">
        {sidebar}
        <div class="main-pane">{explorerBody}</div>
      </div>
    );
  }
  return explorerBody;
}

function compareBy(a: Bookmark, b: Bookmark, sortBy: SortKey): number {
  const ta = a.lastSeenAt ? Date.parse(a.lastSeenAt) || 0 : 0;
  const tb = b.lastSeenAt ? Date.parse(b.lastSeenAt) || 0 : 0;
  const ia = a.lastSeenIndex ?? 1e9;
  const ib = b.lastSeenIndex ?? 1e9;
  switch (sortBy) {
    case "bookmarked-asc":
      return (ta - tb) || (ib - ia) || a.id.localeCompare(b.id);
    case "bookmarked-desc":
      return (tb - ta) || (ia - ib) || b.id.localeCompare(a.id);
    case "created-desc":
      return Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "");
    case "created-asc":
      return Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "");
    case "user":
      return a.username.localeCompare(b.username);
    case "likes":
      return (b.favoriteCount ?? 0) - (a.favoriteCount ?? 0);
    default:
      return 0;
  }
}
