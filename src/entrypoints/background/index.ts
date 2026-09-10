import type {
  ContentMessage,
  PanelMessage,
  PanelReply,
  TabInfo,
} from "@/lib/messaging";

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[tiny-brow] setPanelBehavior failed", err));

  chrome.runtime.onMessage.addListener((msg: PanelMessage, sender, sendResponse) => {
    // Content scripts talk to the panel through here; ignore their own traffic.
    if (sender.tab && !isPanelMessage(msg)) return false;

    console.log("[tiny-brow bg] <-", msg.kind);
    handle(msg)
      .then((reply) => {
        console.log("[tiny-brow bg] ->", reply.ok ? reply.kind : `error: ${reply.error}`);
        sendResponse(reply);
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) } satisfies PanelReply);
      });

    // Keeps the message channel open for the async response.
    return true;
  });
});

function isPanelMessage(msg: unknown): msg is PanelMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    ["ping", "activeTab", "probePage"].includes((msg as PanelMessage).kind)
  );
}

async function handle(msg: PanelMessage): Promise<PanelReply> {
  switch (msg.kind) {
    case "ping":
      return { ok: true, kind: "pong", sentAt: msg.sentAt, receivedAt: Date.now() };

    case "activeTab": {
      const tab = await activeTab();
      return { ok: true, kind: "activeTab", tab };
    }

    case "probePage": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "no active tab" };
      const probe = await chrome.tabs.sendMessage(tab.id, {
        kind: "probePage",
      } satisfies ContentMessage);
      return { ok: true, kind: "probePage", probe };
    }
  }
}

async function activeTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return null;
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
}
