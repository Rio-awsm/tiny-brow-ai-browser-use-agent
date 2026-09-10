import type { CdpStatus, Screenshot } from "./cdp-types";
import type { PageIndex } from "./page-index";

export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export interface PageProbe {
  url: string;
  title: string;
  readyState: string;
  elementCount: number;
}

export type PanelMessage =
  | { kind: "ping"; sentAt: number }
  | { kind: "activeTab" }
  | { kind: "probePage" }
  | { kind: "cdpStatus" }
  | { kind: "cdpAttach" }
  | { kind: "cdpDetach" }
  | { kind: "cdpScreenshot" }
  | { kind: "buildIndex" }
  | { kind: "overlay"; on: boolean };

export type ContentMessage = { kind: "probePage" };

export type PanelReply =
  | { ok: true; kind: "pong"; sentAt: number; receivedAt: number }
  | { ok: true; kind: "activeTab"; tab: TabInfo | null }
  | { ok: true; kind: "probePage"; probe: PageProbe }
  | { ok: true; kind: "cdpStatus"; status: CdpStatus }
  | { ok: true; kind: "cdpScreenshot"; status: CdpStatus; shot: Screenshot }
  | { ok: true; kind: "buildIndex"; status: CdpStatus; index: PageIndex }
  | { ok: true; kind: "overlay"; on: boolean; count: number; index?: PageIndex }
  | { ok: false; error: string };

export const CONTENT_READY = "tiny-brow:content-ready";

const PANEL_KINDS: PanelMessage["kind"][] = [
  "ping",
  "activeTab",
  "probePage",
  "cdpStatus",
  "cdpAttach",
  "cdpDetach",
  "cdpScreenshot",
  "buildIndex",
  "overlay",
];

export function isPanelMessage(msg: unknown): msg is PanelMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    PANEL_KINDS.includes((msg as PanelMessage).kind)
  );
}

export async function sendToBackground(msg: PanelMessage): Promise<PanelReply> {
  try {
    const reply = (await chrome.runtime.sendMessage(msg)) as PanelReply | undefined;
    if (!reply) {
      return { ok: false, error: "background did not reply" };
    }
    return reply;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
