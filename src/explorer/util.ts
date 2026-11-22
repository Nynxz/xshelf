export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}

export function linkify(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s>])@([a-zA-Z0-9_]{1,15})/g, '$1<a href="https://x.com/$2" target="_blank" rel="noopener">@$2</a>');
  s = s.replace(/(^|[\s>])#([a-zA-Z0-9_]+)/g, '$1<a href="https://x.com/hashtag/$2" target="_blank" rel="noopener">#$2</a>');
  return s.replace(/\n/g, "<br>");
}

export function fmtNum(n: number | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

/**
 * Build a relative media path that respects the snapshot's depth from the
 * shared `<folder>/media/` tree. Set by App.tsx on data load via
 * `window.xshelfMediaPrefix` ("media/" for the master, "../media/" for
 * `bookmarks/explorer.html`, "../../media/" for `users/<h>/explorer.html`).
 */
export function mediaPath(safeUser: string, tweetId: string, mediaIndex: number, ext: string): string {
  const prefix = (window as { xshelfMediaPrefix?: string }).xshelfMediaPrefix ?? "media/";
  return `${prefix}${safeUser}/${tweetId}_${mediaIndex}.${ext}`;
}

export function fmtDate(s: string | undefined): string {
  if (!s) return "";
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return s;
  }
}
