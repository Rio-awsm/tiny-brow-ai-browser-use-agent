import type { CdpStatus } from "./cdp-types";
import type { Command } from "./commands";
import type { PageIndex } from "./page-index";
import type { ActionResult } from "@/entrypoints/background/actions";

export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

/**
 * `tabId` pins the target. Without it the background resolves "the active tab"
 * on every call, so a user switching tabs mid-run would silently hand the agent
 * a different page to drive.
 */
export type PanelMessage = PanelMessageBody & { tabId?: number };

type PanelMessageBody =
  | { kind: "ping"; sentAt: number }
  | { kind: "activeTab" }
  | { kind: "cdpStatus" }
  | { kind: "cdpAttach" }
  | { kind: "cdpDetach" }
  | { kind: "buildIndex" }
  | { kind: "overlay"; on: boolean }
  | { kind: "command"; command: Command; cursor: boolean }
  | { kind: "cursor"; on: boolean }
  | { kind: "runStart" }
  | { kind: "runEnd" }
  | { kind: "abort" };

export type PanelReply =
  | { ok: true; kind: "pong"; sentAt: number; receivedAt: number }
  | { ok: true; kind: "activeTab"; tab: TabInfo | null }
  | { ok: true; kind: "cdpStatus"; status: CdpStatus }
  | { ok: true; kind: "buildIndex"; status: CdpStatus; index: PageIndex }
  | { ok: true; kind: "overlay"; on: boolean; count: number; index?: PageIndex }
  | {
      ok: true;
      kind: "command";
      result: ActionResult;
      index?: PageIndex;
      overlayOn: boolean;
      /** Set when the command moved Tiny onto a different tab. */
      tabId?: number;
    }
  | { ok: true; kind: "cursor"; on: boolean }
  | { ok: true; kind: "run"; running: boolean; status: CdpStatus }
  | { ok: true; kind: "abort"; stopped: boolean }
  | { ok: false; error: string };

/** Long-lived port the panel holds open, so the background sees it close. */
export const PANEL_PORT = "tiny-brow:panel";

const PANEL_KINDS: PanelMessageBody["kind"][] = [
  "ping",
  "activeTab",
  "cdpStatus",
  "cdpAttach",
  "cdpDetach",
  "buildIndex",
  "overlay",
  "command",
  "cursor",
  "runStart",
  "runEnd",
  "abort",
];

export function isPanelMessage(msg: unknown): msg is PanelMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    PANEL_KINDS.includes((msg as PanelMessage).kind)
  );
}

/** Nothing the background does should take this long once CDP calls are capped. */
const REPLY_TIMEOUT_MS = 30_000;

async function sendOnce(msg: PanelMessage): Promise<PanelReply | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<PanelReply>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error: `"${msg.kind}" timed out after ${REPLY_TIMEOUT_MS / 1000}s — check the service worker console.`,
        }),
      REPLY_TIMEOUT_MS,
    );
  });

  try {
    return (await Promise.race([
      chrome.runtime.sendMessage(msg) as Promise<PanelReply | undefined>,
      deadline,
    ])) as PanelReply | undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendToBackground(msg: PanelMessage): Promise<PanelReply> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await sendOnce(msg);
      if (reply) return reply;

      // An undefined reply means no listener answered. The usual cause is the
      // MV3 worker having been evicted: the message that wakes it can land
      // before its listeners are registered and be dropped. The second attempt
      // reaches a worker that is now awake.
      if (attempt === 1) {
        console.warn(`[tiny-brow panel] no reply to "${msg.kind}", retrying`);
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      return {
        ok: false,
        error: `background did not reply to "${msg.kind}" (twice) — open the service worker console for the real error`,
      };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (attempt === 1 && /message port closed|Receiving end does not exist/i.test(text)) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      return { ok: false, error: `${msg.kind}: ${text}` };
    }
  }
  return { ok: false, error: `background did not reply to "${msg.kind}"` };
}
