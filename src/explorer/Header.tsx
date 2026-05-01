export type ViewMode = "list" | "grid";
export type SortKey =
  | "bookmarked-desc"
  | "bookmarked-asc"
  | "created-desc"
  | "created-asc"
  | "user"
  | "likes";
export type MediaFilter = "" | "any" | "photo" | "video" | "none";

interface HeaderProps {
  count: number;
  total: number;
  userCounts: Record<string, number>;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  sortBy: SortKey;
  setSortBy: (s: SortKey) => void;
  searchQuery: string;
  setSearchQuery: (s: string) => void;
  userFilter: string;
  setUserFilter: (s: string) => void;
  mediaFilter: MediaFilter;
  setMediaFilter: (m: MediaFilter) => void;
  lastRunFinishedAt: string | null;
  viewMode: ViewMode;
}

export function Header(props: HeaderProps) {
  const sortedUsers = Object.entries(props.userCounts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const lastRun = props.lastRunFinishedAt
    ? new Date(props.lastRunFinishedAt).toLocaleString()
    : "never";

  return (
    <header>
      <div class="header-inner">
        <h1>
          Bookmarks<span class="count">{props.count !== props.total ? `${props.count} / ${props.total}` : props.total}</span>
        </h1>
        <span class="meta" title={`Last run: ${lastRun}`}>
          last: {props.lastRunFinishedAt ? new Date(props.lastRunFinishedAt).toLocaleDateString() : "never"}
        </span>
        <div class="filters">
          <input
            id="search" type="search" placeholder="Search…" autoFocus
            value={props.searchQuery}
            onInput={(e) => props.setSearchQuery((e.target as HTMLInputElement).value)}
          />
          <select
            value={props.userFilter}
            onChange={(e) => props.setUserFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="">All users</option>
            {sortedUsers.map(([u, c]) => (
              <option key={u} value={u}>@{u} ({c})</option>
            ))}
          </select>
          <select
            value={props.mediaFilter}
            onChange={(e) => props.setMediaFilter((e.target as HTMLSelectElement).value as MediaFilter)}
          >
            <option value="">All</option>
            <option value="any">With media</option>
            <option value="photo">Photos</option>
            <option value="video">Videos</option>
            <option value="none">Text only</option>
          </select>
          <select
            value={props.sortBy}
            onChange={(e) => props.setSortBy((e.target as HTMLSelectElement).value as SortKey)}
          >
            <option value="bookmarked-desc">Newest bookmarked</option>
            <option value="bookmarked-asc">Oldest bookmarked</option>
            <option value="created-desc">Newest tweet</option>
            <option value="created-asc">Oldest tweet</option>
            <option value="user">By user</option>
            <option value="likes">Most liked</option>
          </select>
          <div class="view-toggle" role="tablist" aria-label="View mode">
            <button
              class={`view-btn ${props.view === "list" ? "active" : ""}`}
              onClick={() => props.setView("list")}
            >
              List
            </button>
            <button
              class={`view-btn ${props.view === "grid" ? "active" : ""}`}
              onClick={() => props.setView("grid")}
            >
              Grid
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
