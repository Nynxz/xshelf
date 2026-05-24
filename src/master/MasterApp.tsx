import { useMemo, useState } from "preact/hooks";
import type { Bookmark, LastRun, SourceKey } from "../lib/types";
import { BookmarkExplorer } from "../explorer/BookmarkExplorer";
import { Sidebar } from "./Sidebar";

interface SourcePayload {
  source: SourceKey;
  exportedAt: string;
  count: number;
  lastRun: LastRun | null;
  bookmarks: Bookmark[];
}

interface XShelfGlobal {
  sources: Record<string, SourcePayload>;
  sourceList: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  interface Window {
    xshelf?: XShelfGlobal;
  }
}

const ALL_SOURCES = "__all__" as const;
type ActiveKey = SourceKey | typeof ALL_SOURCES;

export function MasterApp() {
  const xshelf = window.xshelf;
  const sourceList = (xshelf?.sourceList ?? []) as SourceKey[];

  // Default: "all" if there are 2+ sources, single source if only one, "all" if zero.
  const [active, setActive] = useState<ActiveKey>(
    sourceList.length === 1 ? sourceList[0] : ALL_SOURCES,
  );

  const allSources = useMemo(() => {
    if (!xshelf) return [] as Array<{ key: SourceKey; data: SourcePayload }>;
    return sourceList
      .map((k) => ({ key: k, data: xshelf.sources[k] }))
      .filter((s) => !!s.data);
  }, [xshelf, sourceList]);

  // Bookmarks for the currently-active scope.
  const { bookmarks, lastRunFinishedAt } = useMemo(() => {
    if (active === ALL_SOURCES) {
      // Merge with id-based dedup so a tweet present in both bookmarks and a
      // user archive only appears once in the merged feed.
      const seen = new Map<string, Bookmark>();
      let latestLastRun: string | null = null;
      for (const s of allSources) {
        for (const b of s.data.bookmarks) {
          if (!seen.has(b.id)) seen.set(b.id, b);
        }
        const t = s.data.lastRun?.finishedAt;
        if (t && (!latestLastRun || t > latestLastRun)) latestLastRun = t;
      }
      return { bookmarks: [...seen.values()], lastRunFinishedAt: latestLastRun };
    }
    const src = allSources.find((s) => s.key === active);
    return {
      bookmarks: src?.data.bookmarks ?? [],
      lastRunFinishedAt: src?.data.lastRun?.finishedAt ?? null,
    };
  }, [allSources, active]);

  if (allSources.length === 0) {
    return (
      <div class="master-empty">
        <h1>xshelf</h1>
        <p>No sources yet. Use the extension's popup to sync your bookmarks or archive a user, then re-open this page.</p>
      </div>
    );
  }

  return (
    <BookmarkExplorer
      bookmarks={bookmarks}
      lastRunFinishedAt={lastRunFinishedAt}
      source={active === ALL_SOURCES ? undefined : (active as SourceKey)}
      sidebar={
        <Sidebar
          sources={allSources}
          active={active}
          allKey={ALL_SOURCES}
          onSelect={setActive}
        />
      }
      headerLeft={<ActiveSourceBadge active={active} />}
    />
  );
}

function ActiveSourceBadge({ active }: { active: ActiveKey }) {
  let label: string;
  if (active === ALL_SOURCES) label = "All sources";
  else if (active === "bookmarks") label = "Bookmarks";
  else label = `@${active.slice("user:".length)}`;
  return <span class="active-source-badge">{label}</span>;
}
