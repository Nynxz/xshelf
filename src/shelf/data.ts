import type { Bookmark, LastRun, Media, SourceKey } from "../lib/types";
import { extFromUrl, sanitizeUsername } from "../lib/bookmarks";

/**
 * Data layer for the shelf explorer. Reads the per-source payloads that each
 * `<source>/data.js` registers on `window.xshelf` (same contract as the
 * classic master explorer) and flattens them into posts + media items.
 */

export interface SourcePayload {
  source: SourceKey;
  exportedAt: string;
  count: number;
  lastRun: LastRun | null;
  bookmarks: Bookmark[];
}

declare global {
  interface Window {
    xshelf?: { sources: Record<string, SourcePayload>; sourceList: string[] };
    xshelfMediaPrefix?: string;
  }
}

export interface SourceInfo {
  key: SourceKey;
  label: string;
  count: number;
  lastRunAt: string | null;
}

export interface Post {
  b: Bookmark;
  sources: SourceKey[];
  media: MediaItem[];
  bookmarkedAt: number;
  postedAt: number;
  /** Lower-cased text/handle/name blob for search. */
  haystack: string;
}

export interface MediaItem {
  /** `<tweetId>_<index>` — stable across sources. */
  key: string;
  post: Post;
  m: Media;
  path: string;
  /** width / height when known (sync-time metadata or learned on load). */
  aspect: number | null;
}

export function sourceLabel(key: string): string {
  if (key === "bookmarks") return "Bookmarks";
  if (key.startsWith("user:")) return `@${key.slice(5)}`;
  return key;
}

export function mediaPath(username: string, tweetId: string, m: Media): string {
  const prefix = window.xshelfMediaPrefix ?? "media/";
  const ext = m.kind === "video" ? "mp4" : (extFromUrl(m.url) ?? "jpg");
  return `${prefix}${sanitizeUsername(username)}/${tweetId}_${m.index}.${ext}`;
}

// ---- learned aspect ratios ------------------------------------------------
// Media saved before width/height were recorded has no dimensions. We learn
// them from the loaded file and persist, but only apply them on the next
// layout (reload / filter change) so tiles never reflow under the reader.

const DIMS_KEY = "xshelf-dims-v1";
let dims: Record<string, number> = {};
try {
  dims = JSON.parse(localStorage.getItem(DIMS_KEY) || "{}");
} catch {
  dims = {};
}
let dimsDirty = false;

export function learnAspect(key: string, w: number, h: number): void {
  if (!w || !h) return;
  const a = Math.round((w / h) * 1000) / 1000;
  if (dims[key] === a) return;
  dims[key] = a;
  if (!dimsDirty) {
    dimsDirty = true;
    setTimeout(() => {
      dimsDirty = false;
      try {
        localStorage.setItem(DIMS_KEY, JSON.stringify(dims));
      } catch {
        // storage full / unavailable — layout just falls back to squares
      }
    }, 1500);
  }
}

function knownAspect(key: string, m: Media): number | null {
  if (m.width && m.height) return m.width / m.height;
  return dims[key] ?? null;
}

// ---- loading --------------------------------------------------------------

export interface Shelf {
  sources: SourceInfo[];
  posts: Post[];
  lastRunAt: string | null;
}

export function loadShelf(): Shelf {
  const x = window.xshelf;
  const keys = (x?.sourceList ?? []) as SourceKey[];
  const byId = new Map<string, Post>();
  const sources: SourceInfo[] = [];
  let lastRunAt: string | null = null;

  for (const key of keys) {
    const payload = x?.sources[key];
    if (!payload) continue;
    const runAt = payload.lastRun?.finishedAt ?? null;
    if (runAt && (!lastRunAt || runAt > lastRunAt)) lastRunAt = runAt;
    sources.push({ key, label: sourceLabel(key), count: payload.count, lastRunAt: runAt });
    for (const b of payload.bookmarks) {
      const existing = byId.get(b.id);
      if (existing) {
        existing.sources.push(key);
        continue;
      }
      const post: Post = {
        b,
        sources: [key],
        media: [],
        bookmarkedAt: Date.parse(b.lastSeenAt) || 0,
        postedAt: Date.parse(b.createdAt ?? "") || 0,
        haystack: `${b.text} @${b.username} ${b.displayName}`.toLowerCase(),
      };
      post.media = b.media.map((m) => {
        const k = `${b.id}_${m.index}`;
        return { key: k, post, m, path: mediaPath(b.username, b.id, m), aspect: knownAspect(k, m) };
      });
      byId.set(b.id, post);
    }
  }

  sources.sort((a, b) =>
    a.key === "bookmarks" ? -1 : b.key === "bookmarks" ? 1 : a.label.localeCompare(b.label),
  );
  return { sources, posts: [...byId.values()], lastRunAt };
}

// ---- filtering ------------------------------------------------------------

export type TypeFilter = "all" | "photo" | "video" | "text" | "missing";
export type SortKey = "saved-desc" | "saved-asc" | "posted-desc" | "posted-asc" | "likes";

export interface Query {
  src: string;
  user: string;
  type: TypeFilter;
  q: string;
  sort: SortKey;
}

/**
 * Keys a disk scan found missing. Once a scan has run, "Missing on disk" uses
 * this real filesystem result instead of the manifest's `downloaded` flags.
 */
let scannedMissing: Set<string> | null = null;
export function setScannedMissing(keys: Set<string> | null): void {
  scannedMissing = keys;
}
const isMissing = (i: MediaItem) => (scannedMissing ? scannedMissing.has(i.key) : !i.m.downloaded);

function postMatchesType(p: Post, type: TypeFilter): boolean {
  switch (type) {
    case "photo":
      return p.media.some((i) => i.m.kind === "photo");
    case "video":
      return p.media.some((i) => i.m.kind === "video");
    case "text":
      return p.media.length === 0;
    case "missing":
      return p.media.some(isMissing);
    default:
      return true;
  }
}

export function mediaMatchesType(i: MediaItem, type: TypeFilter): boolean {
  if (type === "photo") return i.m.kind === "photo";
  if (type === "video") return i.m.kind === "video";
  if (type === "missing") return isMissing(i);
  return true;
}

export function filterPosts(posts: Post[], q: Query, opts: { ignoreUser?: boolean } = {}): Post[] {
  const needle = q.q.trim().toLowerCase();
  const out = posts.filter((p) => {
    if (q.src !== "all" && !p.sources.includes(q.src as SourceKey)) return false;
    if (!opts.ignoreUser && q.user && p.b.username !== q.user) return false;
    if (!postMatchesType(p, q.type)) return false;
    if (needle && !p.haystack.includes(needle)) return false;
    return true;
  });
  const cmp: Record<SortKey, (a: Post, b: Post) => number> = {
    "saved-desc": (a, b) =>
      b.bookmarkedAt - a.bookmarkedAt || (a.b.lastSeenIndex ?? 1e9) - (b.b.lastSeenIndex ?? 1e9),
    "saved-asc": (a, b) =>
      a.bookmarkedAt - b.bookmarkedAt || (b.b.lastSeenIndex ?? 1e9) - (a.b.lastSeenIndex ?? 1e9),
    "posted-desc": (a, b) => b.postedAt - a.postedAt,
    "posted-asc": (a, b) => a.postedAt - b.postedAt,
    likes: (a, b) => (b.b.favoriteCount ?? 0) - (a.b.favoriteCount ?? 0),
  };
  return out.sort(cmp[q.sort]);
}

export interface Person {
  username: string;
  displayName: string;
  posts: number;
  photos: number;
  videos: number;
  preview: MediaItem[];
  excerpt: string;
}

export function groupPeople(posts: Post[]): Person[] {
  const map = new Map<string, Person>();
  for (const p of posts) {
    let person = map.get(p.b.username);
    if (!person) {
      person = { username: p.b.username, displayName: p.b.displayName, posts: 0, photos: 0, videos: 0, preview: [], excerpt: "" };
      map.set(p.b.username, person);
    }
    person.posts++;
    if (!person.excerpt && p.b.text) person.excerpt = p.b.text.trim();
    for (const i of p.media) {
      if (i.m.kind === "video") person.videos++;
      else person.photos++;
      if (i.m.downloaded === false) continue;
      if (person.preview.length < 4) person.preview.push(i);
      else if (i.m.kind === "video" && !person.preview.some((item) => item.m.kind === "video")) {
        person.preview[person.preview.length - 1] = i;
      }
    }
  }
  return [...map.values()].sort((a, b) => b.posts - a.posts || a.username.localeCompare(b.username));
}

// ---- misc helpers -----------------------------------------------------------

/** Stable hue per handle so avatars without images are still recognisable. */
export function handleHue(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function fmtNum(n: number | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function fmtDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
