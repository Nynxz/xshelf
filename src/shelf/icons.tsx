import type { ComponentChildren } from "preact";

/** Stroke icons in the same style as the classic explorer's set. */
function Icon({ size = 18, children }: { size?: number; children: ComponentChildren }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const ISearch = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>;
export const IClose = (p: P) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
export const ILeft = (p: P) => <Icon {...p}><path d="M15 6l-6 6 6 6" /></Icon>;
export const IRight = (p: P) => <Icon {...p}><path d="M9 6l6 6-6 6" /></Icon>;
export const IPanelRight = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Icon>;
export const IExternal = (p: P) => <Icon {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Icon>;
export const IZoomIn = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M11 8v6M8 11h6" /></Icon>;
export const IZoomOut = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6" /></Icon>;
export const IPlay = (p: P) => <Icon {...p}><path d="M7 4l13 8-13 8z" fill="currentColor" /></Icon>;
export const IWarn = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></Icon>;
export const IFeed = (p: P) => <Icon {...p}><rect x="4" y="4" width="16" height="7" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /></Icon>;
export const IWall = (p: P) => <Icon {...p}><rect x="3" y="4" width="8" height="7" rx="1" /><rect x="13" y="4" width="8" height="5" rx="1" /><rect x="3" y="13" width="6" height="7" rx="1" /><rect x="11" y="11" width="10" height="9" rx="1" /></Icon>;
export const IPeople = (p: P) => <Icon {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" /></Icon>;
export const ISun = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
export const IMoon = (p: P) => <Icon {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Icon>;
export const IUp = (p: P) => <Icon {...p}><path d="M6 15l6-6 6 6" /></Icon>;
export const IHeart = (p: P) => <Icon {...p}><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" /></Icon>;
export const IRepost = (p: P) => <Icon {...p}><path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4" /></Icon>;
export const IReply = (p: P) => <Icon {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></Icon>;
export const ILayers = (p: P) => <Icon {...p}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></Icon>;
export const IPhoto = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></Icon>;
export const IVideo = (p: P) => <Icon {...p}><rect x="3" y="5" width="13" height="14" rx="2" /><path d="M16 10l5-3v10l-5-3" /></Icon>;
export const IText = (p: P) => <Icon {...p}><path d="M4 6h16M4 11h16M4 16h10" /></Icon>;
export const ISort = (p: P) => <Icon {...p}><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" /></Icon>;
export const ISliders = (p: P) => <Icon {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Icon>;
export const IDisk = (p: P) => <Icon {...p}><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M5 13l2.5-8h9L19 13M7 16.5h.01M11 16.5h6" /></Icon>;
export const IRows = (p: P) => <Icon {...p}><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="12" y="4" width="9" height="7" rx="1" /><rect x="3" y="13" width="11" height="7" rx="1" /><rect x="16" y="13" width="5" height="7" rx="1" /></Icon>;
export const IMasonry = (p: P) => <Icon {...p}><rect x="3" y="3" width="8" height="10" rx="1" /><rect x="13" y="3" width="8" height="6" rx="1" /><rect x="3" y="15" width="8" height="6" rx="1" /><rect x="13" y="11" width="8" height="10" rx="1" /></Icon>;
export const ISquare = (p: P) => <Icon {...p}><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></Icon>;
export const IHistory = (p: P) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></Icon>;
export const ICheck = (p: P) => <Icon {...p}><path d="M5 12l5 5 9-10" /></Icon>;
export const IBookmarkMinus = (p: P) => <Icon {...p}><path d="M6 4h12v16l-6-4-6 4z" /><path d="M9.5 10h5" /></Icon>;
export const IGear = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Icon>;
export const IHelp = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></Icon>;
export const ISync = (p: P) => <Icon {...p}><path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5" /><path d="M18 3v4h-4M6 21v-4h4" /></Icon>;
export const IUser = (p: P) => <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>;
export const IBookmark = (p: P) => <Icon {...p}><path d="M6 4h12v16l-6-4-6 4z" /></Icon>;
export const IRebuild = (p: P) => <Icon {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></Icon>;
