import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";

/**
 * Minimal window-scroll virtualizer. Items are rendered in normal flow between
 * two spacer divs (not absolutely positioned), so the browser's native scroll
 * anchoring keeps what you're looking at still when heights above it change.
 */

export function useWindowScroll(): { y: number; vh: number } {
  const [s, set] = useState(() => ({ y: window.scrollY, vh: window.innerHeight }));
  useEffect(() => {
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        set({ y: window.scrollY, vh: window.innerHeight });
      });
    };
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, []);
  return s;
}

/** Content-box width of an element, tracked with ResizeObserver. */
export function useWidth(ref: RefObject<HTMLElement>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function docTop(el: HTMLElement | null): number {
  return el ? el.getBoundingClientRect().top + window.scrollY : 0;
}

/** Prefix sums: offsets[i] = top of item i, offsets[n] = total height. */
export function prefix(heights: number[], gap: number): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i] + gap;
  return out;
}

function lowerBound(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Range {
  start: number;
  end: number; // exclusive
  padTop: number;
  padBottom: number;
}

export function useVirtualRange(
  containerRef: RefObject<HTMLElement>,
  offsets: number[],
  overscanPx = 800,
): Range {
  const { y, vh } = useWindowScroll();
  const n = offsets.length - 1;
  const top = docTop(containerRef.current);
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const from = Math.max(0, y - top - overscanPx);
  const to = y - top + vh + overscanPx;
  const start = lowerBound(offsets, from);
  let end = lowerBound(offsets, to) + 1;
  if (end > n) end = n;
  return { start, end, padTop: offsets[start], padBottom: offsets[n] - offsets[end] };
}

const measuredSizes = new Map<string, number>();

/**
 * Variable-height list: estimates until an item is measured, then uses the
 * measured height. Returns a ref-callback factory to attach to each item.
 */
export function useMeasured(
  containerRef: RefObject<HTMLElement>,
  keys: string[],
  estimate: (i: number) => number,
  gap: number,
) {
  // Module-level so measurements survive the view unmounting (switching to
  // the wall and back): restored scroll positions then land on the same posts.
  const sizes = useRef(measuredSizes);
  const [version, setVersion] = useState(0);
  const pending = useRef(false);
  const ro = useMemo(
    () =>
      new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const el = e.target as HTMLElement;
          // A recycled (unmounted) item reports 0×0 — that's not its height.
          if (!el.isConnected) {
            ro.unobserve(el);
            continue;
          }
          const key = el.dataset.vkey;
          if (!key) continue;
          const h = Math.round(el.offsetHeight);
          if (!h) continue;
          if (sizes.current.get(key) !== h) {
            sizes.current.set(key, h);
            changed = true;
          }
        }
        if (changed && !pending.current) {
          pending.current = true;
          requestAnimationFrame(() => {
            pending.current = false;
            setVersion((v) => v + 1);
          });
        }
      }),
    [],
  );
  useEffect(() => () => ro.disconnect(), [ro]);

  const offsets = useMemo(
    () => prefix(keys.map((k, i) => sizes.current.get(k) ?? estimate(i)), gap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, version, gap],
  );

  // Scroll anchoring: when measurements change the height of items above the
  // viewport, shift the scroll position by the same amount so the item the
  // reader is looking at stays put.
  const prev = useRef<{ keys: string[]; offsets: number[] } | null>(null);
  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = { keys, offsets };
    if (!p || p.keys !== keys || !containerRef.current) return;
    const y = window.scrollY - docTop(containerRef.current);
    if (y <= 0) return;
    const i = lowerBound(p.offsets, y);
    const delta = offsets[i] - p.offsets[i];
    if (delta) window.scrollBy(0, delta);
  }, [offsets]);

  const observe = (el: HTMLElement | null) => {
    if (el) ro.observe(el);
  };
  return { offsets, observe };
}

/**
 * Remember scroll position per `key` (e.g. view + filters) for the session,
 * and restore it when that key becomes active again. Position is recorded on
 * every scroll (not on unmount, when the old view's DOM is already gone), and
 * restoring retries for a few frames because a freshly mounted view may not
 * be tall enough yet (the wall needs its measured width before it has rows).
 */
export function useScrollMemory(key: string): (targetKey: string) => void {
  const saved = useRef(new Map<string, number>());
  const keyRef = useRef(key);
  useEffect(() => {
    const on = () => saved.current.set(keyRef.current, window.scrollY);
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    keyRef.current = key;
    const target = saved.current.get(key) ?? 0;
    let tries = 0;
    let raf = 0;
    const attempt = () => {
      window.scrollTo(0, target);
      if (Math.abs(window.scrollY - target) > 2 && tries++ < 30) raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(raf);
  }, [key]);

  return (targetKey) => {
    saved.current.delete(targetKey);
    if (targetKey === keyRef.current) window.scrollTo(0, 0);
  };
}
