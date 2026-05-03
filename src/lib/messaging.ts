import type { CapturedSummary, Manifest, RuntimeState, SyncOptions } from "./types";

/**
 * The full set of typed messages the popup/explorer can send to the background.
 * Discriminated by `type`; each shape has its own response type.
 */
export type RequestMessage =
  | { type: "getRunState" }
  | { type: "getManifest"; source?: import("./types").SourceKey }
  | { type: "startSync"; options: SyncOptions }
  | { type: "startDownload" }
  | { type: "discardPending" }
  | { type: "cancelBackup" }
  | { type: "clearManifest"; source?: import("./types").SourceKey }
  | { type: "listSources" }
  | { type: "wipeAll" };

export type ResponseFor<T extends RequestMessage["type"]> =
  T extends "getRunState"
    ? { ok: true; version: string; state: RuntimeState; captured: CapturedSummary }
    : T extends "getManifest"
      ? { ok: true; manifest: Manifest }
      : { ok: true } | { ok: false; error: string };

/** Server-pushed events */
export type BroadcastMessage =
  | { type: "stateUpdate"; state: RuntimeState };

export const SW_VERSION = "v27-master-explorer";

export function send<T extends RequestMessage>(
  msg: T,
): Promise<ResponseFor<T["type"]>> {
  return chrome.runtime.sendMessage(msg) as Promise<ResponseFor<T["type"]>>;
}
