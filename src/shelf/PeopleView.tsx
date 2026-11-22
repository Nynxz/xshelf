import { useMemo, useRef } from "preact/hooks";
import { fmtNum, type Person } from "./data";
import { Avatar } from "./FeedView";
import { Thumb } from "./Thumb";
import { prefix, useVirtualRange, useWidth } from "./virtual";

const CARD_MIN = 280;
const CARD_H = 252;
const GAP = 14;

/** Everyone in the current scope as cards; picking one filters the wall to them. */
export function PeopleView({ people, onPick }: { people: Person[]; onPick: (username: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP)));
  const rowCount = Math.ceil(people.length / cols);
  const offsets = useMemo(() => prefix(new Array(rowCount).fill(CARD_H), GAP), [rowCount]);
  const range = useVirtualRange(ref, offsets, 800);

  if (people.length === 0) {
    return (
      <div ref={ref} class="empty">
        No people match these filters.
      </div>
    );
  }

  const rows = [];
  for (let r = range.start; r < range.end; r++) {
    rows.push(
      <div class="people-row" key={r} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, height: CARD_H }}>
        {people.slice(r * cols, r * cols + cols).map((p) => (
          <button type="button" class="person" key={p.username} onClick={() => onPick(p.username)}>
            <span class="person-head">
              <Avatar username={p.username} displayName={p.displayName} size={44} />
              <span class="person-who">
                <span class="person-name">{p.displayName || p.username}</span>
                <span class="muted">@{p.username}</span>
              </span>
            </span>
            {p.preview.length > 0 ? (
              <span class="person-strip" style={{ gridTemplateColumns: `repeat(${p.preview.length}, minmax(0, 1fr))` }}>
                {p.preview.map((item) => <Thumb key={item.key} item={item} videoFrame />)}
              </span>
            ) : (
              <span class="person-excerpt">
                <span>{p.excerpt || (p.photos || p.videos ? "Previews unavailable" : "Text-only posts")}</span>
              </span>
            )}
            <span class="person-stats">
              <span>
                <b>{fmtNum(p.posts)}</b> {p.posts === 1 ? "post" : "posts"}
              </span>
              <span>
                <b>{fmtNum(p.photos)}</b> {p.photos === 1 ? "photo" : "photos"}
              </span>
              <span>
                <b>{fmtNum(p.videos)}</b> {p.videos === 1 ? "video" : "videos"}
              </span>
            </span>
          </button>
        ))}
      </div>,
    );
  }

  return (
    <div ref={ref} class="people" aria-label="People">
      <div style={{ height: range.padTop }} />
      {rows}
      <div style={{ height: range.padBottom }} />
    </div>
  );
}
