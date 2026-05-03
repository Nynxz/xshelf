/**
 * Inline SVG icons. Each component takes an optional size and class; stroke
 * uses `currentColor` so they pick up the parent's text color.
 */

interface IconProps {
  size?: number;
  class?: string;
  title?: string;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function svg(size: number | undefined, className: string | undefined, children: any, title?: string) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      class={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      <g {...stroke}>{children}</g>
    </svg>
  );
}

export const IconList = (p: IconProps) => svg(p.size, p.class, (
  <>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </>
), p.title);

export const IconGrid = (p: IconProps) => svg(p.size, p.class, (
  <>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </>
), p.title);

export const IconClose = (p: IconProps) => svg(p.size, p.class, (
  <>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </>
), p.title);

export const IconChevronLeft = (p: IconProps) => svg(p.size, p.class, (
  <polyline points="15 6 9 12 15 18" />
), p.title);

export const IconChevronRight = (p: IconProps) => svg(p.size, p.class, (
  <polyline points="9 6 15 12 9 18" />
), p.title);

export const IconInfo = (p: IconProps) => svg(p.size, p.class, (
  <>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
  </>
), p.title);

export const IconSettings = (p: IconProps) => svg(p.size, p.class, (
  <>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
    <circle cx="9" cy="6" r="2" fill="var(--bg, #15202b)" />
    <circle cx="15" cy="12" r="2" fill="var(--bg, #15202b)" />
    <circle cx="8" cy="18" r="2" fill="var(--bg, #15202b)" />
  </>
), p.title);

export const IconExternal = (p: IconProps) => svg(p.size, p.class, (
  <>
    <path d="M14 4h6v6" />
    <line x1="20" y1="4" x2="11" y2="13" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </>
), p.title);

export const IconReply = (p: IconProps) => svg(p.size, p.class, (
  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
), p.title);

export const IconRetweet = (p: IconProps) => svg(p.size, p.class, (
  <>
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </>
), p.title);

export const IconHeart = (p: IconProps) => svg(p.size, p.class, (
  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
), p.title);

export const IconQuote = (p: IconProps) => svg(p.size, p.class, (
  <>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    <line x1="9" y1="10" x2="15" y2="10" />
    <line x1="9" y1="13" x2="13" y2="13" />
  </>
), p.title);

export const IconPlay = (p: IconProps) => svg(p.size, p.class, (
  <polygon points="6 4 20 12 6 20" fill="currentColor" />
), p.title);

export const IconSidebar = (p: IconProps) => svg(p.size, p.class, (
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </>
), p.title);
