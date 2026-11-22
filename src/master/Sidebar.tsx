import type { Bookmark, LastRun, SourceKey } from "../lib/types";

interface SourcePayload {
  source: SourceKey;
  exportedAt: string;
  count: number;
  lastRun: LastRun | null;
  bookmarks: Bookmark[];
}

interface Props {
  sources: Array<{ key: SourceKey; data: SourcePayload }>;
  active: SourceKey | "__all__";
  allKey: "__all__";
  onSelect: (key: SourceKey | "__all__") => void;
}

export function Sidebar({ sources, active, allKey, onSelect }: Props) {
  // Bookmarks first, then users alphabetically by handle.
  const sorted = [...sources].sort((a, b) => {
    if (a.key === "bookmarks") return -1;
    if (b.key === "bookmarks") return 1;
    return a.key.localeCompare(b.key);
  });

  const totalCount = sources.reduce((n, s) => n + s.data.count, 0);

  return (
    <aside class="sidebar">
      <div class="sidebar-title">xshelf</div>
      <a class="source-pill" href="index.html">
        <span class="source-name">New explorer →</span>
      </a>

      <button
        class={`source-pill ${active === allKey ? "active" : ""}`}
        onClick={() => onSelect(allKey)}
      >
        <span class="source-name">All sources</span>
        <span class="source-count">{totalCount}</span>
      </button>

      <div class="source-section-label">Sources</div>
      {sorted.map((s) => (
        <button
          key={s.key}
          class={`source-pill ${active === s.key ? "active" : ""}`}
          onClick={() => onSelect(s.key)}
          title={s.data.lastRun ? `Last sync: ${new Date(s.data.lastRun.finishedAt).toLocaleString()}` : undefined}
        >
          <span class="source-name">{labelFor(s.key)}</span>
          <span class="source-count">{s.data.count}</span>
        </button>
      ))}
    </aside>
  );
}

function labelFor(key: SourceKey): string {
  if (key === "bookmarks") return "Bookmarks";
  return `@${key.slice("user:".length)}`;
}
