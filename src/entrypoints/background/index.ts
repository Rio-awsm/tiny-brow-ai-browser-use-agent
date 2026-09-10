import * as cdp from "./cdp";
import { buildIndex } from "./extract";
import { hideHighlights, isOverlayOn, showHighlights } from "./overlay";
import { navigateTab, openTab, NO_INDEX, runCommand } from "./actions";
import { registerSettleTracking, waitForSettle } from "./settle";
import {
  Aborted,
  abortRun,
  beginAction,
  endAction,
  endRun,
  isSession,
  registerPanelLifecycle,
  signalFor,
  startRun,
} from "./run";
import * as cursor from "./cursor";
import {
  isPanelMessage,
  type ContentMessage,
  type PanelMessage,
  type PanelReply,
  type TabInfo,
} from "@/lib/messaging";

/**
 * Opens the panel however this browser can.
 *
 * `chrome.sidePanel` is Chrome and Edge; other Chromium builds may not ship it.
 * Reaching for it unguarded throws during background startup, which takes the
 * message listener down with it — so the extension does not merely lose its
 * side panel, it stops responding altogether. The fallback is a popup window
 * showing the same page.
 */
function registerPanelOpener() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error("[tiny-brow] setPanelBehavior failed", err));
    return;
  }

  console.warn("[tiny-brow] no sidePanel API here — opening in a window instead");
  chrome.action.onClicked.addListener(() => {
    void chrome.windows.create({
      url: chrome.runtime.getURL("/sidepanel.html"),
      type: "popup",
      width: 460,
      height: 900,
    });
  });
}

export default defineBackground(() => {
  registerPanelOpener();

  cdp.registerCdpLifecycle();
  registerSettleTracking();
  registerPanelLifecycle();

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isPanelMessage(msg)) return false;
    // Content scripts share this channel; their replies are not ours to handle.
    if (sender.tab) return false;

    console.log("[tiny-brow bg] <-", msg.kind);
    try {
      handle(msg)
        .then((reply) => {
          console.log("[tiny-brow bg] ->", reply.ok ? reply.kind : `error: ${reply.error}`);
          sendResponse(reply);
        })
        .catch((err: unknown) => {
          // Log the whole error, not just its message: the stack is the only
          // way to tell a CDP refusal from a bug in our own handler.
          console.error("[tiny-brow bg] handler rejected", msg.kind, err);
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies PanelReply);
        });
    } catch (err) {
      // A synchronous throw would otherwise close the port with no response,
      // which the panel can only report as silence.
      console.error("[tiny-brow bg] handler threw synchronously", msg.kind, err);
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies PanelReply);
      return false;
    }

    return true;
  });
});

async function handle(msg: PanelMessage): Promise<PanelReply> {
  const requireTarget = () => requireTab(msg.tabId);

  switch (msg.kind) {
    case "ping":
      return { ok: true, kind: "pong", sentAt: msg.sentAt, receivedAt: Date.now() };

    case "activeTab":
      return { ok: true, kind: "activeTab", tab: await activeTab() };

    case "probePage": {
      const tab = await requireTarget();
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
      const tab = await requireTarget();
      await cdp.attach(tab.id, tab.url, true);
      return { ok: true, kind: "cdpStatus", status: await cdp.status(tab.id, tab.url) };
    }

    case "cdpDetach": {
      const tab = await requireTarget();
      await cdp.detach(tab.id);
      return { ok: true, kind: "cdpStatus", status: await cdp.status(tab.id, tab.url) };
    }

    case "buildIndex": {
      const tab = await requireTarget();
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

    case "runStart": {
      const tab = await requireTarget();
      await startRun(tab.id, tab.url);
      return { ok: true, kind: "run", running: true, status: await cdp.status(tab.id, tab.url) };
    }

    case "runEnd": {
      const tab = await requireTarget();
      await endRun(tab.id);
      return { ok: true, kind: "run", running: false, status: await cdp.status(tab.id, tab.url) };
    }

    case "abort": {
      const tab = await requireTarget();
      return { ok: true, kind: "abort", stopped: abortRun(tab.id) };
    }

    case "command": {
      const tab = await requireTarget();

      // Handled before any attach, so it works on pages Chrome will not let us
      // debug — otherwise a new-tab page is a dead end the agent cannot escape.
      if (msg.command.kind === "goto") {
        const result = await navigateTab(tab.id, msg.command.url);
        return { ok: true, kind: "command", result, overlayOn: false };
      }
      if (msg.command.kind === "newtab") {
        const { result, tabId } = await openTab(msg.command.url);
        return { ok: true, kind: "command", result, overlayOn: false, tabId };
      }

      const inRun = isSession(tab.id);
      const signal = signalFor(tab.id);
      const wasAttached = inRun || (await cdp.status(tab.id, tab.url)).state === "attached";
      beginAction(tab.id);
      await cdp.attach(tab.id, tab.url, inRun);
      try {
        const hadOverlay = await isOverlayOn(tab.id);

        let result;
        try {
          result = await runCommand(tab.id, msg.command, msg.cursor, signal);
        } catch (err) {
          if (err instanceof Aborted) throw err;
          // Only index when the page has none. Re-indexing first would renumber
          // everything under a user who is acting on numbers they can see.
          if (!(err instanceof Error) || !err.message.includes(NO_INDEX)) throw err;
          await buildIndex(tab.id);
          result = await runCommand(tab.id, msg.command, msg.cursor, signal);
        }

        // Wait for the page to be worth reading before re-indexing it.
        const settle = await waitForSettle(tab.id, { signal });
        if (settle.timedOut) {
          result.detail = [result.detail, `${settle.timedOut} never settled (${settle.tookMs}ms)`]
            .filter(Boolean)
            .join(" · ");
        }
        const index = await buildIndex(tab.id);
        if (hadOverlay) await showHighlights(tab.id);
        // A click that navigated took the cursor with it; put it back.
        if (msg.cursor) await cursor.ensure(tab.id).catch(() => {});
        return { ok: true, kind: "command", result, index, overlayOn: hadOverlay };
      } finally {
        if (!wasAttached) await cdp.detach(tab.id).catch(() => {});
      }
    }

    case "cursor": {
      const tab = await requireTarget();
      const wasAttached = (await cdp.status(tab.id, tab.url)).state === "attached";
      await cdp.attach(tab.id, tab.url, false);
      try {
        if (msg.on) await cursor.ensure(tab.id);
        else await cursor.remove(tab.id);
        return { ok: true, kind: "cursor", on: msg.on };
      } finally {
        endAction(tab.id);
        // A run owns the session; only a one-off action closes it behind itself.
        if (!wasAttached) await cdp.detach(tab.id).catch(() => {});
      }
    }

    case "overlay": {
      const tab = await requireTarget();
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
      const tab = await requireTarget();
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

/** The pinned tab when the panel named one, otherwise whatever is in front. */
async function requireTab(tabId?: number): Promise<TabInfo> {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return { id: tabId, url: tab.url ?? "", title: tab.title ?? "" };
    } catch {
      throw new Error(`Tab ${tabId} is gone — it was closed during the run.`);
    }
  }
  const tab = await activeTab();
  if (!tab) throw new Error("No active tab.");
  return tab;
}
