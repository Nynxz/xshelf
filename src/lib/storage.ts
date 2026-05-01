import type { Captured, Manifest, PendingMediaItem, RuntimeState } from "./types";

const RUN_STATE_KEY = "xbd_runState";
const MANIFEST_KEY = "xbd_manifest_v1";
const CAPTURED_KEY = "xbd_captured_v1";
const PENDING_KEY = "xbd_pending_v1";

export const StorageKeys = {
  runState: RUN_STATE_KEY,
  manifest: MANIFEST_KEY,
  captured: CAPTURED_KEY,
  pending: PENDING_KEY,
} as const;

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

export function freshManifest(): Manifest {
  return { version: 1, bookmarks: {}, lastRun: null };
}

export async function loadRuntime(): Promise<RuntimeState | null> {
  const data = await chrome.storage.local.get(RUN_STATE_KEY);
  return (data[RUN_STATE_KEY] as RuntimeState | undefined) ?? null;
}

export async function saveRuntime(runtime: RuntimeState): Promise<void> {
  await chrome.storage.local.set({ [RUN_STATE_KEY]: runtime });
}

export async function loadManifest(): Promise<Manifest> {
  const data = await chrome.storage.local.get(MANIFEST_KEY);
  return (data[MANIFEST_KEY] as Manifest | undefined) ?? freshManifest();
}

export async function saveManifest(m: Manifest): Promise<void> {
  await chrome.storage.local.set({ [MANIFEST_KEY]: m });
}

export async function clearManifest(): Promise<void> {
  await chrome.storage.local.remove(MANIFEST_KEY);
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
