import { useCallback, useEffect, useState } from "preact/hooks";
import type { Query, SortKey, TypeFilter } from "./data";

/**
 * All navigational state lives in the URL hash, so reload restores the view,
 * the browser's Back button closes the lightbox, and a view can be bookmarked
 * (`index.html#view=wall&user=someone&type=video`).
 */

export type ViewKey = "feed" | "wall" | "people";

export interface Route extends Query {
  view: ViewKey;
  /** Media key (`<tweetId>_<index>`) open in the lightbox, or "". */
  lb: string;
}

export const DEFAULT_ROUTE: Route = { view: "wall", src: "all", user: "", type: "all", q: "", sort: "saved-desc", lb: "" };

const VIEWS: ViewKey[] = ["feed", "wall", "people"];
const TYPES: TypeFilter[] = ["all", "photo", "video", "text", "missing"];
const SORTS: SortKey[] = ["saved-desc", "saved-asc", "posted-desc", "posted-asc", "likes"];

function parse(hash: string): Route {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
    const v = p.get(k) as T | null;
    return v && allowed.includes(v) ? v : d;
  };
  return {
    view: pick("view", VIEWS, DEFAULT_ROUTE.view),
    src: p.get("src") || DEFAULT_ROUTE.src,
    user: p.get("user") || "",
    type: pick("type", TYPES, DEFAULT_ROUTE.type),
    q: p.get("q") || "",
    sort: pick("sort", SORTS, DEFAULT_ROUTE.sort),
    lb: p.get("lb") || "",
  };
}

function serialize(r: Route): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULT_ROUTE) as (keyof Route)[]) {
    if (r[k] !== DEFAULT_ROUTE[k]) p.set(k, String(r[k]));
  }
  const s = p.toString();
  return s ? `#${s}` : location.pathname + location.search;
}

export function useRoute(): [Route, (patch: Partial<Route>, opts?: { push?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));

  useEffect(() => {
    const onPop = () => setRoute(parse(location.hash));
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  const update = useCallback((patch: Partial<Route>, opts: { push?: boolean } = {}) => {
    setRoute((prev) => {
      const next = { ...prev, ...patch };
      const url = serialize(next);
      if (opts.push) history.pushState(null, "", url);
      else history.replaceState(null, "", url);
      return next;
    });
  }, []);

  return [route, update];
}
