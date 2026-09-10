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
  | { kind: "probePage" };

export type ContentMessage = { kind: "probePage" };

export type PanelReply =
  | { ok: true; kind: "pong"; sentAt: number; receivedAt: number }
  | { ok: true; kind: "activeTab"; tab: TabInfo | null }
  | { ok: true; kind: "probePage"; probe: PageProbe }
  | { ok: false; error: string };

export const CONTENT_READY = "tiny-brow:content-ready";

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
