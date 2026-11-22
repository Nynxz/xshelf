/**
 * Justified-row layout (Flickr/Google Photos style): pack items into rows of
 * roughly `target` height so each row exactly fills `width`.
 */

export interface Row {
  start: number;
  end: number; // exclusive
  height: number;
  widths: number[];
}

const MIN_ASPECT = 0.5;
const MAX_ASPECT = 2.6;

/** True when a tile laid out for `aspect` has exactly the media's shape (cover won't crop). */
export function exactAspect(aspect: number | null): boolean {
  return aspect != null && aspect >= MIN_ASPECT && aspect <= MAX_ASPECT;
}

export function justify(aspects: number[], width: number, target: number, gap: number): Row[] {
  const rows: Row[] = [];
  if (width <= 0) return rows;
  let start = 0;
  let sum = 0;
  for (let i = 0; i < aspects.length; i++) {
    const a = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspects[i] || 1));
    sum += a;
    const n = i - start + 1;
    const naturalWidth = sum * target + gap * (n - 1);
    if (naturalWidth >= width) {
      const height = (width - gap * (n - 1)) / sum;
      rows.push(makeRow(aspects, start, i + 1, height));
      start = i + 1;
      sum = 0;
    }
  }
  if (start < aspects.length) {
    // Last row: keep the target height rather than blowing items up.
    rows.push(makeRow(aspects, start, aspects.length, target));
  }
  return rows;
}

function makeRow(aspects: number[], start: number, end: number, height: number): Row {
  const widths: number[] = [];
  for (let i = start; i < end; i++) {
    const a = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspects[i] || 1));
    widths.push(Math.floor(a * height));
  }
  return { start, end, height: Math.floor(height), widths };
}
