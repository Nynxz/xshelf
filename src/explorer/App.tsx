import { useEffect, useState } from "preact/hooks";
import type { Bookmark, Manifest, SourceKey } from "../lib/types";
import { BookmarkExplorer } from "./BookmarkExplorer";

/**
 * Per-source explorer entry. Loads a single source's data either from the
 * inlined snapshot JSON (file:// snapshot mode) or chrome.storage (extension
 * page mode) and hands it to the shared BookmarkExplorer component.
 *
 * The master / cross-source view is in src/master/MasterApp.tsx and uses the
 * same BookmarkExplorer with a sidebar.
 */
export function App() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [lastRunFinishedAt, setLastRunFinishedAt] = useState<string | null>(null);
  const [source, setSource] = useState<SourceKey | undefined>(undefined);

  useEffect(() => {
    // Snapshot mode: bookmarks inlined as <script id="xbd-data" type="application/json">
    const dataEl = document.getElementById("xbd-data");
    if (
      dataEl?.textContent &&
      dataEl.textContent.trim() !== "" &&
      !dataEl.textContent.includes("__BOOKMARKS_DATA__")
    ) {
      try {
        const parsed = JSON.parse(dataEl.textContent) as {
          bookmarks: Bookmark[];
          lastRun?: { finishedAt: string };
          mediaPathPrefix?: string;
          source?: SourceKey;
        };
        // Stash the snapshot's media path prefix on window so card/grid/lightbox
        // components don't have to thread it through.
        (window as any).xshelfMediaPrefix = parsed.mediaPathPrefix ?? "media/";
        setBookmarks(parsed.bookmarks);
        setLastRunFinishedAt(parsed.lastRun?.finishedAt ?? null);
        setSource(parsed.source);
        return;
      } catch {
        // fall through to live mode
      }
    }
    if (!(window as any).xshelfMediaPrefix) (window as any).xshelfMediaPrefix = "media/";

    // Live mode (chrome-extension page) — only available inside the extension context.
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    chrome.storage.local.get("xbd_manifest_v1").then((data) => {
      const m = (data["xbd_manifest_v1"] as Manifest | undefined) ?? null;
      if (m) {
        setBookmarks(Object.values(m.bookmarks));
        setLastRunFinishedAt(m.lastRun?.finishedAt ?? null);
        setSource("bookmarks");
      }
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes["xbd_manifest_v1"]) {
        const m = changes["xbd_manifest_v1"].newValue as Manifest | undefined;
        if (m) {
          setBookmarks(Object.values(m.bookmarks));
          setLastRunFinishedAt(m.lastRun?.finishedAt ?? null);
          setSource("bookmarks");
        }
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  return (
    <BookmarkExplorer
      bookmarks={bookmarks}
      lastRunFinishedAt={lastRunFinishedAt}
      source={source}
    />
  );
}
