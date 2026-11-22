import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { MediaItem } from "./data";
import { Thumb } from "./Thumb";

const ROW_HEIGHT = 80;
const OVERSCAN = 3;

/** Fixed-height thumbnail rows keep the scrollable rail small even for large archives. */
export function LightboxThumbnails({
  items,
  index,
  onNavigate,
}: {
  items: MediaItem[];
  index: number;
  onNavigate: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: OVERSCAN });

  const measure = (rail: HTMLDivElement) => {
    const start = Math.max(0, Math.floor(rail.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.ceil((rail.scrollTop + rail.clientHeight) / ROW_HEIGHT) + OVERSCAN;
    setRange((prev) => prev.start === start && prev.end === end ? prev : { start, end });
  };

  useLayoutEffect(() => {
    const rail = ref.current;
    if (!rail) return;
    const observer = new ResizeObserver(() => measure(rail));
    observer.observe(rail);
    measure(rail);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const rail = ref.current;
    if (!rail) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
    measure(rail);
  }, [index, items.length]);

  const { start, end } = range;

  return (
    <div
      id="lb-thumbnails"
      class="lb-thumbnails"
      role="region"
      aria-label="Media thumbnails"
      tabIndex={0}
      ref={ref}
      onScroll={(e) => measure(e.currentTarget)}
    >
      <div style={{ height: items.length * ROW_HEIGHT, position: "relative" }}>
        <div style={{ position: "absolute", top: start * ROW_HEIGHT, insetInline: 0 }}>
          {items.slice(start, end).map((item, offset) => {
            const i = start + offset;
            return (
              <div class="lb-thumbnail-row" style={{ height: ROW_HEIGHT }} key={item.key}>
                <button
                  type="button"
                  class="lb-thumbnail"
                  aria-current={i === index ? "true" : undefined}
                  aria-label={`Open ${item.m.kind} ${i + 1} of ${items.length}`}
                  onClick={() => onNavigate(i)}
                >
                  {item.m.kind === "photo" ? <Thumb item={item} fit="contain" /> : <span class="lb-post-video">▶</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
