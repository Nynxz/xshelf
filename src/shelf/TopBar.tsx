import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import brandIcon from "../assets/icon.svg";
import type { SortKey, SourceInfo, TypeFilter } from "./data";
import type { Route, ViewKey } from "./route";
import type { WallLayout, WallSize } from "./WallView";
import {
  ICheck,
  IClose,
  IDisk,
  IFeed,
  IHistory,
  ILayers,
  IMasonry,
  IMoon,
  IPeople,
  IPhoto,
  IRows,
  ISearch,
  ISliders,
  ISort,
  ISquare,
  ISun,
  IText,
  IUp,
  IVideo,
  IWall,
  IWarn,
} from "./icons";

export type Theme = "dark" | "light";

type Opt<K> = { key: K; label: string; icon: () => JSX.Element };

const VIEWS: Opt<ViewKey>[] = [
  { key: "wall", label: "Wall", icon: () => <IWall /> },
  { key: "feed", label: "Feed", icon: () => <IFeed /> },
  { key: "people", label: "People", icon: () => <IPeople /> },
];

const TYPES: Opt<TypeFilter>[] = [
  { key: "all", label: "Everything", icon: () => <ILayers /> },
  { key: "photo", label: "Photos", icon: () => <IPhoto /> },
  { key: "video", label: "Videos", icon: () => <IVideo /> },
  { key: "text", label: "Text only", icon: () => <IText /> },
  { key: "missing", label: "Missing on disk", icon: () => <IWarn /> },
];

const LAYOUTS: Opt<WallLayout>[] = [
  { key: "justified", label: "Rows", icon: () => <IRows size={16} /> },
  { key: "masonry", label: "Masonry", icon: () => <IMasonry size={16} /> },
  { key: "square", label: "Square", icon: () => <ISquare size={16} /> },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "saved-desc", label: "Saved · newest" },
  { key: "saved-asc", label: "Saved · oldest" },
  { key: "posted-desc", label: "Posted · newest" },
  { key: "posted-asc", label: "Posted · oldest" },
  { key: "likes", label: "Most liked" },
];

/** Segmented icon group; the label is the tooltip and the accessible name. */
function IconSeg<K extends string>({
  label,
  options,
  value,
  onPick,
  badge,
}: {
  label: string;
  options: Opt<K>[];
  value: K;
  onPick: (k: K) => void;
  badge?: Partial<Record<K, string>>;
}) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.key}
          class="seg-btn"
          aria-pressed={value === o.key}
          aria-label={o.label}
          data-tip={o.label}
          onClick={() => onPick(o.key)}
        >
          {o.icon()}
          {badge?.[o.key] && <span class="seg-badge">{badge[o.key]}</span>}
        </button>
      ))}
    </div>
  );
}

/** Toolbar button with a panel that closes on outside press or Escape. */
function Menu({
  label,
  icon,
  triggerClass = "icon-btn",
  disabledReason,
  children,
  onOpenChange,
}: {
  label: string;
  icon: JSX.Element;
  triggerClass?: string;
  disabledReason?: string;
  children: (close: () => void) => ComponentChildren;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const disabled = !!disabledReason;
  const set = (v: boolean) => {
    setOpen(v);
    onOpenChange(v);
  };
  const closeAndFocus = () => {
    set(false);
    ref.current?.querySelector("button")?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (disabled && open) set(false);
  }, [disabled, open]);
  useEffect(() => {
    if (!open || disabled) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) set(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (ref.current?.contains(document.activeElement)) closeAndFocus();
        else set(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, disabled]);
  return (
    <div class="menu" ref={ref}>
      <button
        type="button"
        class={triggerClass}
        aria-label={label}
        data-tip={open || disabled ? undefined : label}
        title={disabledReason}
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={() => set(!open)}
      >
        {icon}
      </button>
      {open && !disabled && <div class="menu-panel">{children(closeAndFocus)}</div>}
    </div>
  );
}

export function TopBar({
  route,
  update,
  onHome,
  sources,
  summary,
  size,
  setSize,
  layout,
  setLayout,
  theme,
  setTheme,
  onScan,
  scanned,
}: {
  route: Route;
  update: (p: Partial<Route>) => void;
  onHome: () => void;
  sources: SourceInfo[];
  summary: string;
  size: WallSize;
  setSize: (s: WallSize) => void;
  layout: WallLayout;
  setLayout: (l: WallLayout) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onScan: () => void;
  /** Missing count from this session's disk scan, or null if none ran. */
  scanned: number | null;
}) {
  // Auto-hide while scrolling down, reveal on any scroll up. Stays put while
  // a menu is open or something in the bar (e.g. search) has focus.
  const [hidden, setHidden] = useState(false);
  const pinned = useRef(false);
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const busy = pinned.current || barRef.current?.contains(document.activeElement);
      if (busy || y < 80 || y < last - 4) setHidden(false);
      else if (y > last + 4) setHidden(true);
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const pin = (open: boolean) => {
    pinned.current = open;
    if (open) setHidden(false);
  };
  const sourceOptions = [{ key: "all", label: "All sources", count: null }, ...sources];
  const selectedSource = sourceOptions.find((s) => s.key === route.src) ?? sourceOptions[0];

  return (
    <header ref={barRef} class={`bar ${hidden ? "bar-hidden" : ""}`}>
      <button
        type="button"
        class="brand"
        aria-label="XShelf home"
        data-tip="Explorer home"
        onClick={onHome}
      >
        <img src={brandIcon} width="24" height="24" alt="" />
        <span>XShelf</span>
      </button>

      <IconSeg label="View" options={VIEWS} value={route.view} onPick={(view) => update({ view })} />

      <label class="search">
        <ISearch size={16} />
        <span class="sr-only">Search</span>
        {route.user && (
          <button
            type="button"
            class="search-token"
            onClick={(e) => {
              e.preventDefault();
              update({ user: "" });
            }}
            aria-label={`Remove filter @${route.user}`}
          >
            @{route.user} <IClose size={12} />
          </button>
        )}
        <input
          type="search"
          placeholder="Search"
          value={route.q}
          onInput={(e) => update({ q: (e.target as HTMLInputElement).value })}
        />
        <span class="search-count" title={summary}>
          {summary.split(" from ")[0]}
        </span>
      </label>

      <IconSeg
        label="Type"
        options={TYPES}
        value={route.type}
        onPick={(type) => update({ type })}
        badge={scanned ? { missing: scanned > 999 ? "999+" : String(scanned) } : undefined}
      />

      <div class="source-picker">
        <Menu
          label={`Source: ${selectedSource.label}`}
          triggerClass="source-trigger"
          icon={<><ILayers size={16} /><span>{selectedSource.label}</span><IUp size={12} /></>}
          onOpenChange={pin}
        >
          {(close) => (
            <div class="menu-list" role="group" aria-label="Sources">
              {sourceOptions.map((source) => (
                <button
                  type="button"
                  key={source.key}
                  class="menu-item source-option"
                  aria-pressed={source.key === selectedSource.key}
                  onClick={() => { update({ src: source.key }); close(); }}
                >
                  <span class="menu-check">{source.key === selectedSource.key && <ICheck size={14} />}</span>
                  <span class="source-option-label">{source.label}</span>
                  {source.count !== null && <span class="muted">{source.count.toLocaleString()}</span>}
                </button>
              ))}
            </div>
          )}
        </Menu>
      </div>

      <div class="bar-tools">
        <Menu
          label="Sort"
          icon={<ISort />}
          disabledReason={route.view === "people" ? "Sort is available in Wall and Feed" : undefined}
          onOpenChange={pin}
        >
          {(close) => (
            <div class="menu-list" role="group" aria-label="Sort">
              {SORTS.map((s) => (
                <button
                  type="button"
                  key={s.key}
                  class="menu-item"
                  aria-pressed={route.sort === s.key}
                  onClick={() => {
                    update({ sort: s.key });
                    close();
                  }}
                >
                  <span class="menu-check">{route.sort === s.key && <ICheck size={14} />}</span>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </Menu>

        <Menu label="Display" icon={<ISliders />} onOpenChange={pin}>
          {() => (
            <div class="menu-grid">
              <span class="menu-label">Wall layout</span>
              <div class="seg seg-wide" role="group" aria-label="Wall layout">
                {LAYOUTS.map((l) => (
                  <button
                    type="button"
                    key={l.key}
                    class="seg-btn"
                    aria-pressed={layout === l.key}
                    onClick={() => {
                      setLayout(l.key);
                      if (route.view !== "wall") update({ view: "wall" });
                    }}
                  >
                    {l.icon()}
                    <span>{l.label}</span>
                  </button>
                ))}
              </div>
              <span class="menu-label">Tile size</span>
              <div class="seg seg-wide" role="group" aria-label="Tile size">
                {(["s", "m", "l"] as WallSize[]).map((s) => (
                  <button type="button" key={s} class="seg-btn" aria-pressed={size === s} onClick={() => setSize(s)}>
                    {{ s: "Small", m: "Medium", l: "Large" }[s]}
                  </button>
                ))}
              </div>
              <span class="menu-label">Theme</span>
              <div class="seg seg-wide" role="group" aria-label="Theme">
                {(["dark", "light"] as Theme[]).map((t) => (
                  <button type="button" key={t} class="seg-btn" aria-pressed={theme === t} onClick={() => setTheme(t)}>
                    {t === "dark" ? <IMoon size={16} /> : <ISun size={16} />}
                    <span>{t === "dark" ? "Dark" : "Light"}</span>
                  </button>
                ))}
              </div>
              <a class="menu-link" href="classic.html">
                <IHistory size={16} /> Classic explorer
              </a>
            </div>
          )}
        </Menu>

        <button type="button" class="icon-btn" aria-label="Check files on disk" data-tip="Check files on disk" onClick={onScan}>
          <IDisk />
        </button>
      </div>
    </header>
  );
}
