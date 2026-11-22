import { useMemo, useRef } from "preact/hooks";
import type { MutableRef } from "preact/hooks";
import type { MediaItem } from "./data";
import { exactAspect, justify } from "./justify";
import { Thumb, type Fit } from "./Thumb";
import { docTop, prefix, useVirtualRange, useWidth, useWindowScroll } from "./virtual";

export type WallSize = "s" | "m" | "l";
/**
 * natural: justified rows, each tile at the media's shape.
 * masonry: columns, each tile at the media's shape (no cropping at all).
 * square:  uniform cropped squares — the only layout that crops.
 */
export type WallLayout = "justified" | "masonry" | "square";

const ROW_TARGET: Record<WallSize, number> = { s: 140, m: 230, l: 360 };
const COL_TARGET: Record<WallSize, number> = { s: 180, m: 270, l: 400 };
const GAP = 6;

interface Props {
  items: MediaItem[];
  size: WallSize;
  layout: WallLayout;
  onOpen: (key: string) => void;
  revealRef: MutableRef<((key: string) => void) | null>;
}

/** Every media item as one continuous, virtualized wall. */
export function WallView(props: Props) {
  return props.layout === "masonry" ? <Masonry {...props} /> : <Rows {...props} />;
}

function revealAt(container: HTMLElement | null, top: number, height: number): void {
  const abs = docTop(container) + top;
  if (abs < window.scrollY + 120 || abs + height > window.scrollY + window.innerHeight) {
    window.scrollTo(0, Math.max(0, abs - window.innerHeight / 3));
  }
}

function Tile({ item, style, fit, onOpen }: { item: MediaItem; style: Record<string, string | number>; fit: Fit; onOpen: (k: string) => void }) {
  return (
    <button
      type="button"
      class="tile"
      style={style}
      onClick={() => onOpen(item.key)}
      aria-label={`Open ${item.m.kind} by @${item.post.b.username}`}
    >
      <Thumb item={item} fit={fit} hoverPlay />
      <span class="tile-caption">@{item.post.b.username}</span>
    </button>
  );
}

// ---- justified rows / squares ----------------------------------------------

function Rows({ items, size, layout, onOpen, revealRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const square = layout === "square";

  const aspects = useMemo(() => items.map((i) => (square ? 1 : (i.aspect ?? 1))), [items, square]);
  const rows = useMemo(() => justify(aspects, width, ROW_TARGET[size], GAP), [aspects, width, size]);
  const offsets = useMemo(() => prefix(rows.map((r) => r.height), GAP), [rows]);
  const range = useVirtualRange(ref, offsets, 1400);

  // Keep the item that's open in the lightbox in view behind it, so closing
  // the lightbox lands exactly where you are rather than where you started.
  revealRef.current = (key: string) => {
    const idx = items.findIndex((i) => i.key === key);
    const r = rows.findIndex((row) => idx >= row.start && idx < row.end);
    if (r >= 0) revealAt(ref.current, offsets[r], rows[r].height);
  };

  if (items.length === 0) return <Empty r={ref} />;

  return (
    <div ref={ref} class="wall" aria-label="Media wall">
      <div style={{ height: range.padTop }} />
      {rows.slice(range.start, range.end).map((row) => (
        <div class="wall-row" key={row.start} style={{ height: row.height }}>
          {row.widths.map((w, j) => {
            const item = items[row.start + j];
            const isLast = row.end === items.length;
            // Squares crop by design; otherwise only fill the tile when it has
            // the media's real shape, and letterbox when the shape is unknown.
            const fit: Fit = square || exactAspect(item.aspect) ? "cover" : "contain";
            return (
              <Tile key={item.key} item={item} fit={fit} onOpen={onOpen} style={{ width: w, flexGrow: isLast ? 0 : w }} />
            );
          })}
        </div>
      ))}
      <div style={{ height: range.padBottom }} />
    </div>
  );
}

// ---- masonry ------------------------------------------------------------------

const BUCKET = 1000;

function Masonry({ items, size, onOpen, revealRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const { y, vh } = useWindowScroll();

  const layout = useMemo(() => {
    const cols = Math.max(1, Math.round((width + GAP) / (COL_TARGET[size] + GAP)));
    const colW = width > 0 ? (width - GAP * (cols - 1)) / cols : 0;
    const heights = new Array<number>(cols).fill(0);
    const pos: Array<{ x: number; y: number; h: number }> = [];
    // Bucket items by vertical band so finding what's on screen is cheap
    // even for very large archives.
    const buckets: number[][] = [];
    for (let i = 0; i < items.length; i++) {
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c]) c = k;
      // Unknown shape: a square slot with the media letterboxed inside.
      const h = Math.round(colW / (items[i].aspect ?? 1));
      const top = heights[c];
      pos.push({ x: c * (colW + GAP), y: top, h });
      heights[c] += h + GAP;
      for (let b = Math.floor(top / BUCKET); b <= Math.floor((top + h) / BUCKET); b++) (buckets[b] ??= []).push(i);
    }
    return { colW, pos, buckets, total: Math.max(0, ...heights) };
  }, [items, width, size]);

  revealRef.current = (key: string) => {
    const idx = items.findIndex((i) => i.key === key);
    if (idx >= 0) revealAt(ref.current, layout.pos[idx].y, layout.pos[idx].h);
  };

  if (items.length === 0) return <Empty r={ref} />;

  const top = docTop(ref.current);
  const from = Math.max(0, Math.floor((y - top - 1200) / BUCKET));
  const to = Math.floor((y - top + vh + 1200) / BUCKET);
  const visible = new Set<number>();
  for (let b = from; b <= to; b++) for (const i of layout.buckets[b] ?? []) visible.add(i);

  return (
    <div ref={ref} class="wall wall-masonry" style={{ height: layout.total }} aria-label="Media wall">
      {[...visible]
        .sort((a, b) => a - b)
        .map((i) => {
          const p = layout.pos[i];
          const item = items[i];
          return (
            <Tile
              key={item.key}
              item={item}
              fit={item.aspect != null ? "cover" : "contain"}
              onOpen={onOpen}
              style={{ position: "absolute", left: p.x, top: p.y, width: layout.colW, height: p.h }}
            />
          );
        })}
    </div>
  );
}

function Empty({ r }: { r: MutableRef<HTMLDivElement | null> }) {
  return (
    <div ref={r} class="empty">
      No media matches these filters.
    </div>
  );
}
