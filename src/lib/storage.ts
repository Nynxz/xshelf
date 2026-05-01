import type { Captured, Manifest, PendingMediaItem, RuntimeState, SourceKey } from "./types";

const RUN_STATE_KEY = "xbd_runState";
const CAPTURED_KEY = "xbd_captured_v1";
const PENDING_KEY = "xbd_pending_v1";

/** Index of all known source keys; updated whenever a source is added or removed. */
const SOURCES_KEY = "xbd_sources";
/** Per-source manifest key prefix. Final key e.g. `xbd_manifest_bookmarks`,
 *  `xbd_manifest_user_elonmusk` (the colon in `user:<handle>` is replaced by `_`). */
const MANIFEST_PREFIX = "xbd_manifest_";

/** Legacy single-bookmark manifest key from v1. Auto-migrated on startup. */
const LEGACY_MANIFEST_KEY = "xbd_manifest_v1";
const MIGRATION_DONE_KEY = "xbd_migration_v2_done";

export const StorageKeys = {
  runState: RUN_STATE_KEY,
  captured: CAPTURED_KEY,
  pending: PENDING_KEY,
  sources: SOURCES_KEY,
} as const;

export function manifestStorageKey(source: SourceKey): string {
  // chrome.storage keys can have colons but we replace for cosmetic consistency
  // with the disk path (no colon-paths in filesystems).
  return MANIFEST_PREFIX + source.replace(":", "_");
}

export function freshRuntime(): RuntimeState {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    currentPhase: null,
    options: null,
    pageCount: 0,
    totalSeen: 0,
    newCount: 0,
    totalKnown: 0,
    mediaTotal: 0,
    mediaDone: 0,
    mediaSkipped: 0,
    mediaErrored: 0,
    errorMessage: null,
    pendingSummary: { count: 0, tweetCount: 0, photoCount: 0, videoCount: 0, byUser: {} },
    log: [],
  };
}

export function freshManifest(source: SourceKey): Manifest {
  return { version: 2, source, bookmarks: {}, lastRun: null };
}

export async function loadRuntime(): Promise<RuntimeState | null> {
  const data = await chrome.storage.local.get(RUN_STATE_KEY);
  return (data[RUN_STATE_KEY] as RuntimeState | undefined) ?? null;
}

export async function saveRuntime(runtime: RuntimeState): Promise<void> {
  await chrome.storage.local.set({ [RUN_STATE_KEY]: runtime });
}

export async function listSources(): Promise<SourceKey[]> {
  const data = await chrome.storage.local.get(SOURCES_KEY);
  const arr = data[SOURCES_KEY];
  return Array.isArray(arr) ? (arr as SourceKey[]) : [];
}

export async function registerSource(source: SourceKey): Promise<void> {
  const sources = await listSources();
  if (sources.includes(source)) return;
  sources.push(source);
  await chrome.storage.local.set({ [SOURCES_KEY]: sources });
}

export async function unregisterSource(source: SourceKey): Promise<void> {
  const sources = await listSources();
  const next = sources.filter((s) => s !== source);
  await chrome.storage.local.set({ [SOURCES_KEY]: next });
  await chrome.storage.local.remove(manifestStorageKey(source));
}

export async function loadManifest(source: SourceKey): Promise<Manifest> {
  const key = manifestStorageKey(source);
  const data = await chrome.storage.local.get(key);
  return (data[key] as Manifest | undefined) ?? freshManifest(source);
}

export async function saveManifest(m: Manifest): Promise<void> {
  await chrome.storage.local.set({ [manifestStorageKey(m.source)]: m });
  await registerSource(m.source);
}

export async function clearManifest(source: SourceKey): Promise<void> {
  await chrome.storage.local.remove(manifestStorageKey(source));
}

/**
 * Migrate a v1 manifest stored under `xbd_manifest_v1` to the v2 multi-source
 * layout (under `xbd_manifest_bookmarks`, with the source registered in the
 * index). Idempotent — runs at most once per profile.
 */
export async function migrateLegacyManifest(): Promise<{ migrated: boolean; count: number }> {
  const flags = await chrome.storage.local.get([MIGRATION_DONE_KEY, LEGACY_MANIFEST_KEY]);
  if (flags[MIGRATION_DONE_KEY]) return { migrated: false, count: 0 };

  const legacy = flags[LEGACY_MANIFEST_KEY] as { bookmarks?: Record<string, unknown>; lastRun?: unknown } | undefined;
  if (!legacy || !legacy.bookmarks) {
    await chrome.storage.local.set({ [MIGRATION_DONE_KEY]: true });
    return { migrated: false, count: 0 };
  }

  const v2: Manifest = {
    version: 2,
    source: "bookmarks",
    bookmarks: legacy.bookmarks as Manifest["bookmarks"],
    lastRun: (legacy.lastRun as Manifest["lastRun"]) ?? null,
  };
  await saveManifest(v2);
  await chrome.storage.local.set({ [MIGRATION_DONE_KEY]: true });
  // Don't delete the legacy key for a release — gives the user a recovery path
  // if anything goes wrong with the new code.
  return { migrated: true, count: Object.keys(v2.bookmarks).length };
}

export async function loadCaptured(): Promise<Captured> {
  const data = await chrome.storage.local.get(CAPTURED_KEY);
  const stored = data[CAPTURED_KEY] as Partial<Captured> | undefined;
  return {
    auth: stored?.auth ?? null,
    queryId: stored?.queryId ?? null,
    operation: stored?.operation ?? null,
  };
}

export async function saveCaptured(c: Captured): Promise<void> {
  await chrome.storage.local.set({ [CAPTURED_KEY]: c });
}

export async function loadPending(): Promise<PendingMediaItem[]> {
  const data = await chrome.storage.local.get(PENDING_KEY);
  const arr = data[PENDING_KEY];
  return Array.isArray(arr) ? (arr as PendingMediaItem[]) : [];
}

export async function savePending(items: PendingMediaItem[]): Promise<void> {
  await chrome.storage.local.set({ [PENDING_KEY]: items });
}

export async function clearPending(): Promise<void> {
  await chrome.storage.local.remove(PENDING_KEY);
}

export async function wipeAll(): Promise<void> {
  await chrome.storage.local.clear();
  try {
    await chrome.storage.session.clear();
  } catch {
    // not all browsers support session storage
  }
}
