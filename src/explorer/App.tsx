import { useEffect, useMemo, useState, useCallback } from "preact/hooks";
import type { Bookmark, Manifest } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";
import { Header, type SortKey, type ViewMode, type MediaFilter } from "./Header";
import { BookmarkCard } from "./BookmarkCard";
import { GridTile, type MediaPair } from "./GridTile";
import { Lightbox } from "./Lightbox";

const PAGE_SIZE = 50;
const GRID_PAGE_SIZE = 200;

export function App() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [lastRunFinishedAt, setLastRunFinishedAt] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("list");
  const [sortBy, setSortBy] = useState<SortKey>("bookmarked-desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("");
  const [renderedCount, setRenderedCount] = useState(PAGE_SIZE);
  const [lbIndex, setLbIndex] = useState(-1);

  // Load bookmarks from chrome.storage on mount.
  useEffect(() => {
    chrome.storage.local.get("xbd_manifest_v1").then((data) => {
      const m = (data["xbd_manifest_v1"] as Manifest | undefined) ?? null;
      if (m) {
        setBookmarks(Object.values(m.bookmarks));
        setLastRunFinishedAt(m.lastRun?.finishedAt ?? null);
      }
    });
    // Re-load if storage changes (e.g., a sync finishes while explorer is open).
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes["xbd_manifest_v1"]) {
        const m = changes["xbd_manifest_v1"].newValue as Manifest | undefined;
        if (m) {
          setBookmarks(Object.values(m.bookmarks));
          setLastRunFinishedAt(m.lastRun?.finishedAt ?? null);
        }
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

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

  // Reset pagination when filters change.
  useEffect(() => setRenderedCount(view === "grid" ? GRID_PAGE_SIZE : PAGE_SIZE),
    [searchQuery, userFilter, mediaFilter, sortBy, view]);

  const mediaList = useMemo<MediaPair[]>(() => {
    const list: MediaPair[] = [];
    for (const b of filtered) {
      for (const m of b.media) list.push({ b, m });
    }
    return list;
  }, [filtered]);

  const items = view === "grid" ? mediaList : filtered;
  const visible = items.slice(0, renderedCount);

  const onCloseLightbox = useCallback(() => setLbIndex(-1), []);

  return (
    <>
      <Header
        count={items.length}
        total={view === "grid" ? bookmarks.length : bookmarks.length}
        userCounts={userCounts}
        view={view} setView={setView}
        sortBy={sortBy} setSortBy={setSortBy}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        userFilter={userFilter} setUserFilter={setUserFilter}
        mediaFilter={mediaFilter} setMediaFilter={setMediaFilter}
        lastRunFinishedAt={lastRunFinishedAt}
        viewMode={view}
      />

      <main class={view === "grid" ? "view-grid" : ""}>
        {visible.length === 0 ? (
          <div class="empty">{view === "grid" ? "No media matches." : "Nothing matches."}</div>
        ) : view === "grid" ? (
          (visible as MediaPair[]).map((pair, i) => (
            <GridTile key={`${pair.b.id}_${pair.m.index}`} pair={pair} onClick={() => setLbIndex(i)} />
          ))
        ) : (
          (visible as Bookmark[]).map((b) => <BookmarkCard key={b.id} bookmark={b} />)
        )}
        {renderedCount < items.length && (
          <button class="load-more" onClick={() => setRenderedCount((n) => n + (view === "grid" ? GRID_PAGE_SIZE : PAGE_SIZE))}>
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

// Re-export so other files can build local paths the same way the SW does.
export { extFromUrl, sanitizeUsername };
