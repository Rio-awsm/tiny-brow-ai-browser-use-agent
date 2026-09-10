import * as cdp from "./cdp";
import { buildIndex } from "./extract";
import { hideHighlights, showHighlights } from "./overlay";
import {
  isPanelMessage,
  type ContentMessage,
  type PanelMessage,
  type PanelReply,
  type TabInfo,
} from "@/lib/messaging";

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[tiny-brow] setPanelBehavior failed", err));

  cdp.registerCdpLifecycle();

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isPanelMessage(msg)) return false;
    // Content scripts share this channel; their replies are not ours to handle.
    if (sender.tab) return false;

    console.log("[tiny-brow bg] <-", msg.kind);
    handle(msg)
      .then((reply) => {
        console.log("[tiny-brow bg] ->", reply.ok ? reply.kind : `error: ${reply.error}`);
        sendResponse(reply);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        console.warn("[tiny-brow bg] -> error:", error);
        sendResponse({ ok: false, error } satisfies PanelReply);
      });

    return true;
  });
});

async function handle(msg: PanelMessage): Promise<PanelReply> {
  switch (msg.kind) {
    case "ping":
      return { ok: true, kind: "pong", sentAt: msg.sentAt, receivedAt: Date.now() };

    case "activeTab":
      return { ok: true, kind: "activeTab", tab: await activeTab() };

    case "probePage": {
      const tab = await requireTab();
      const probe = await chrome.tabs.sendMessage(tab.id, {
        kind: "probePage",
      } satisfies ContentMessage);
      return { ok: true, kind: "probePage", probe };
    }

    case "cdpStatus": {
      const tab = await activeTab();
      return {
        ok: true,
        kind: "cdpStatus",
        status: await cdp.status(tab?.id ?? null, tab?.url ?? ""),
      };
    }

    case "cdpAttach": {
      const tab = await requireTab();
      await cdp.attach(tab.id, tab.url, true);
      return { ok: true, kind: "cdpStatus", status: await cdp.status(tab.id, tab.url) };
    }

    case "cdpDetach": {
      const tab = await requireTab();
      await cdp.detach(tab.id);
      return { ok: true, kind: "cdpStatus", status: await cdp.status(tab.id, tab.url) };
    }

    case "buildIndex": {
      const tab = await requireTab();
      // Indexing needs a session; keep whatever mode the tab is already in.
      const wasAttached = (await cdp.status(tab.id, tab.url)).state === "attached";
      await cdp.attach(tab.id, tab.url, false);
      try {
        const index = await buildIndex(tab.id);
        return {
          ok: true,
          kind: "buildIndex",
          status: await cdp.status(tab.id, tab.url),
          index,
        };
      } finally {
        if (!wasAttached) await cdp.detach(tab.id).catch(() => {});
      }
    }

    case "overlay": {
      const tab = await requireTab();
      const wasAttached = (await cdp.status(tab.id, tab.url)).state === "attached";
      await cdp.attach(tab.id, tab.url, false);
      try {
        if (!msg.on) {
          return { ok: true, kind: "overlay", on: false, count: await hideHighlights(tab.id) };
        }
        // Always re-index before drawing, so the numbers on screen are the
        // numbers the model would be given right now.
        const index = await buildIndex(tab.id);
        const count = await showHighlights(tab.id);
        return { ok: true, kind: "overlay", on: true, count, index };
      } finally {
        // The overlay keeps itself positioned once injected, so the session can
        // close and take Chrome's banner with it.
        if (!wasAttached) await cdp.detach(tab.id).catch(() => {});
      }
    }

    case "cdpScreenshot": {
      const tab = await requireTab();
      const shot = await cdp.screenshot(tab.id, tab.url);
      return {
        ok: true,
        kind: "cdpScreenshot",
        status: await cdp.status(tab.id, tab.url),
        shot,
      };
    }
  }
}

async function activeTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return null;
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
}

async function requireTab(): Promise<TabInfo> {
  const tab = await activeTab();
  if (!tab) throw new Error("No active tab.");
  return tab;
}
