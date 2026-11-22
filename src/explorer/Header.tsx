import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { IconList, IconGrid, IconSettings } from "./icons";

export type ViewMode = "list" | "grid";
export type SortKey =
  | "bookmarked-desc"
  | "bookmarked-asc"
  | "created-desc"
  | "created-asc"
  | "user"
  | "likes";
export type MediaFilter = "" | "any" | "photo" | "video" | "none";
export type ImageFit = "contain" | "cover";
export type DisplaySize = "small" | "medium" | "large";

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
  imageFit: ImageFit;
  setImageFit: (f: ImageFit) => void;
  size: DisplaySize;
  setSize: (s: DisplaySize) => void;
  lastRunFinishedAt: string | null;
  /** Optional content rendered before the title (used by master view to surface the active source label). */
  leadingContent?: ComponentChildren;
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
        {props.leadingContent}
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
          <SettingsButton {...props} />
          <div class="view-toggle" role="tablist" aria-label="View mode">
            <button
              class={`view-btn ${props.view === "list" ? "active" : ""}`}
              onClick={() => props.setView("list")}
              title="List view"
              aria-label="List view"
            >
              <IconList />
            </button>
            <button
              class={`view-btn ${props.view === "grid" ? "active" : ""}`}
              onClick={() => props.setView("grid")}
              title="Grid view"
              aria-label="Grid view"
            >
              <IconGrid />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

function SettingsButton(props: HeaderProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div class="settings-wrap" ref={wrapRef}>
      <button
        class={`icon-btn ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Display options"
        aria-label="Display options"
        aria-expanded={open}
      >
        <IconSettings />
      </button>
      {open && (
        <div class="settings-panel" role="dialog" aria-label="Display options">
          <div class="settings-row">
            <span class="settings-label">Size</span>
            <div class="seg">
              {(["small", "medium", "large"] as DisplaySize[]).map((s) => (
                <button
                  key={s}
                  class={`seg-btn ${props.size === s ? "active" : ""}`}
                  onClick={() => props.setSize(s)}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-label">Image fit</span>
            <div class="seg">
              <button
                class={`seg-btn ${props.imageFit === "contain" ? "active" : ""}`}
                onClick={() => props.setImageFit("contain")}
                title="Show the whole image; may letterbox"
              >
                Contain
              </button>
              <button
                class={`seg-btn ${props.imageFit === "cover" ? "active" : ""}`}
                onClick={() => props.setImageFit("cover")}
                title="Crop to fill"
              >
                Cover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
