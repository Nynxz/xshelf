import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { filterPosts, groupPeople, loadShelf, mediaMatchesType, setScannedMissing, sourceLabel } from "./data";
import { DiskScan, type ScanResult } from "./DiskScan";
import { FeedView } from "./FeedView";
import { IUp } from "./icons";
import { Lightbox } from "./Lightbox";
import { PeopleView } from "./PeopleView";
import { DEFAULT_ROUTE, useRoute, type Route } from "./route";
import { TopBar, type Theme } from "./TopBar";
import { useScrollMemory, useWindowScroll } from "./virtual";
import { WallView, type WallLayout, type WallSize } from "./WallView";

function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // per-viewer convenience only
    }
  };
  return [v, set];
}

function scrollKey(route: Route): string {
  return `${route.view}|${route.src}|${route.user}|${route.type}|${route.q}|${route.sort}`;
}

export function App() {
  const shelf = useMemo(loadShelf, []);
  const [route, update] = useRoute();
  const [size, setSize] = usePref<WallSize>("xshelf-wall-size", "m");
  const [layout, setLayout] = usePref<WallLayout>("xshelf-wall-layout", "justified");
  const [theme, setTheme] = usePref<Theme>(
    "xshelf-theme",
    window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const revealRef = useRef<((key: string) => void) | null>(null);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [scanOpen, setScanOpen] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const scanVersion = scan?.scannedAt ?? "";

  const posts = useMemo(
    () => filterPosts(shelf.posts, route),
    [shelf, route.src, route.user, route.type, route.q, route.sort, scanVersion],
  );
  const media = useMemo(
    () => posts.flatMap((p) => p.media.filter((i) => mediaMatchesType(i, route.type))),
    [posts, route.type],
  );
  const people = useMemo(
    () => groupPeople(filterPosts(shelf.posts, route, { ignoreUser: true })),
    [shelf, route.src, route.type, route.q],
  );

  // Lightbox navigates within what the current view shows. A feed post can
  // show media the type filter excludes (a photo in a post matched by
  // "Videos"); then fall back to every item of the visible posts.
  const lbItems = useMemo(
    () =>
      !route.lb || media.some((i) => i.key === route.lb) ? media : posts.flatMap((p) => p.media),
    [media, posts, route.lb],
  );
  const lbIndex = route.lb ? lbItems.findIndex((i) => i.key === route.lb) : -1;
  const lbPushed = useRef(false);
  const openLb = (key: string) => {
    lbPushed.current = true;
    update({ lb: key }, { push: true });
  };
  const closeLb = () => {
    if (lbPushed.current) {
      lbPushed.current = false;
      history.back(); // pops the entry openLb pushed; popstate clears `lb`
    } else {
      update({ lb: "" });
    }
  };
  useEffect(() => {
    if (!route.lb) lbPushed.current = false;
    else if (route.view === "wall" || route.view === "feed") revealRef.current?.(route.lb);
  }, [route.lb, route.view]);

  const showUser = (username: string) => {
    if (route.lb) lbPushed.current = false;
    update({ user: username, view: route.view === "people" ? "wall" : route.view, lb: "" });
  };

  // Scroll position is remembered per view+filters; a new filter starts at the top.
  const resetScroll = useScrollMemory(scrollKey(route));
  const goHome = () => {
    resetScroll(scrollKey(DEFAULT_ROUTE));
    if (location.hash) update(DEFAULT_ROUTE, { push: true });
  };

  const scanItems = route.view === "people" ? posts.flatMap((p) => p.media) : media;

  const summary =
    route.view === "people"
      ? `${people.length.toLocaleString()} people`
      : route.view === "wall"
        ? `${media.length.toLocaleString()} media from ${posts.length.toLocaleString()} posts`
        : `${posts.length.toLocaleString()} posts`;

  if (shelf.sources.length === 0) {
    return (
      <div class="first-run">
        <h1>xshelf</h1>
        <p>No sources yet. Sync your bookmarks or archive a user from the extension popup, then reopen this page.</p>
      </div>
    );
  }

  return (
    <>
      <TopBar
        route={route}
        update={update}
        onHome={goHome}
        sources={shelf.sources}
        summary={summary}
        size={size}
        setSize={setSize}
        layout={layout}
        setLayout={setLayout}
        theme={theme}
        setTheme={setTheme}
        onScan={() => setScanOpen(true)}
        scanned={scan ? scan.missing.length : null}
      />
      <main class={`content content-${route.view}`}>
        {route.view === "wall" && (
          <WallView items={media} size={size} layout={layout} onOpen={openLb} revealRef={revealRef} />
        )}
        {route.view === "feed" && <FeedView posts={posts} onOpen={openLb} onUser={showUser} revealRef={revealRef} />}
        {route.view === "people" && <PeopleView people={people} onPick={showUser} />}
      </main>
      <BackToTop />
      {scanOpen && (
        <DiskScan
          items={scanItems}
          scope={[
            route.src === "all" ? "all sources" : sourceLabel(route.src),
            route.user && `@${route.user}`,
            route.type !== "all" && route.type,
            route.q && `“${route.q}”`,
          ]
            .filter(Boolean)
            .join(" · ")}
          onClose={() => setScanOpen(false)}
          onResult={(r) => {
            // Merge into any earlier scan so scanning views one at a time
            // builds up a complete picture.
            const keys = new Set(scan?.missing.map((i) => i.key) ?? []);
            const checked = new Set(scanItems.map((i) => i.key));
            for (const k of [...keys]) if (checked.has(k)) keys.delete(k);
            for (const i of r.missing) keys.add(i.key);
            setScannedMissing(keys);
            setScan(r);
          }}
          onShowMissing={() => {
            setScanOpen(false);
            update({ type: "missing", view: route.view === "people" ? "wall" : route.view });
          }}
        />
      )}
      {lbIndex >= 0 && (
        <Lightbox
          items={lbItems}
          index={lbIndex}
          onNavigate={(i) => update({ lb: lbItems[i].key })}
          onClose={closeLb}
          onUser={showUser}
        />
      )}
    </>
  );
}

function BackToTop() {
  const { y } = useWindowScroll();
  if (y < 360) return null;
  const scrollToTop = () => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "instant" : "smooth" });
  };
  return (
    <button type="button" class="to-top" onClick={scrollToTop} aria-label="Back to top" title="Back to top">
      <IUp size={20} />
    </button>
  );
}
