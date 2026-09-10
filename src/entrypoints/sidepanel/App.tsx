import { useCallback, useEffect, useState } from "react";
import { Composer, type ToolId } from "@/components/Composer";
import { PanelHeader } from "@/components/PanelHeader";
import { Transcript } from "@/components/Transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sendToBackground, type PanelMessage } from "@/lib/messaging";
import { estimateTokens, serializeIndex } from "@/lib/page-index";
import { usePanel } from "@/lib/store";

const TOOL_MESSAGE: Record<ToolId, PanelMessage> = {
  attach: { kind: "cdpAttach" },
  detach: { kind: "cdpDetach" },
  capture: { kind: "cdpScreenshot" },
  index: { kind: "buildIndex" },
  overlay: { kind: "overlay", on: true },
  ping: { kind: "ping", sentAt: 0 },
  tab: { kind: "activeTab" },
  page: { kind: "probePage" },
};

export function App() {
  const {
    task, running, tab, cdp, events,
    setTask, setRunning, setTab, setCdp, note, push, clear,
  } = usePanel();
  const [busyTool, setBusyTool] = useState<ToolId | null>(null);
  const [overlayOn, setOverlayOn] = useState(false);

  const refresh = useCallback(async () => {
    const tabReply = await sendToBackground({ kind: "activeTab" });
    if (!tabReply.ok || tabReply.kind !== "activeTab") return null;
    setTab(tabReply.tab);

    const cdpReply = await sendToBackground({ kind: "cdpStatus" });
    if (cdpReply.ok && cdpReply.kind === "cdpStatus") setCdp(cdpReply.status);
    return tabReply.tab;
  }, [setTab, setCdp]);

  // A navigation destroys the overlay along with the page it was drawn on, so
  // the toggle has to follow the URL rather than remember what the user clicked.
  useEffect(() => {
    setOverlayOn(false);
  }, [tab?.url, tab?.id]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    chrome.tabs.onUpdated.addListener(onChange);
    chrome.tabs.onActivated.addListener(onChange);
    chrome.tabs.onRemoved.addListener(onChange);

    // Chrome can end a debugger session without telling the panel, and the
    // background worker can be evicted mid-session. Polling keeps the status
    // honest rather than showing whatever was true when the panel last acted.
    const poll = setInterval(onChange, 2500);

    return () => {
      chrome.tabs.onUpdated.removeListener(onChange);
      chrome.tabs.onActivated.removeListener(onChange);
      chrome.tabs.onRemoved.removeListener(onChange);
      clearInterval(poll);
    };
  }, [refresh]);

  const runTool = async (tool: ToolId) => {
    setBusyTool(tool);
    const msg =
      tool === "ping"
        ? { kind: "ping" as const, sentAt: Date.now() }
        : tool === "overlay"
          ? { kind: "overlay" as const, on: !overlayOn }
          : TOOL_MESSAGE[tool];
    note("sent", `${tool} → background`);

    const reply = await sendToBackground(msg);

    if (!reply.ok) {
      note("error", reply.error);
      await refresh();
      setBusyTool(null);
      return;
    }

    switch (reply.kind) {
      case "pong":
        note("recv", `pong in ${Date.now() - reply.sentAt}ms`);
        break;
      case "activeTab":
        setTab(reply.tab);
        note("recv", reply.tab ? `tab ${reply.tab.id} · ${reply.tab.url}` : "no active tab");
        break;
      case "probePage":
        note(
          "recv",
          `${reply.probe.readyState} · ${reply.probe.elementCount} nodes · ${reply.probe.title}`,
        );
        break;
      case "cdpStatus":
        setCdp(reply.status);
        note("recv", `debugger ${reply.status.state}`);
        break;
      case "cdpScreenshot":
        setCdp(reply.status);
        push({ kind: "shot", shot: reply.shot });
        break;
      case "overlay":
        setOverlayOn(reply.on);
        if (reply.index) push({ kind: "index", index: reply.index });
        note(
          "recv",
          reply.on
            ? `overlay on — ${reply.count} element${reply.count === 1 ? "" : "s"} highlighted`
            : "overlay off",
        );
        break;
      case "buildIndex": {
        setCdp(reply.status);
        push({ kind: "index", index: reply.index });
        const tokens = estimateTokens(serializeIndex(reply.index.elements));
        if (tokens > 2000) {
          note("error", `index is ~${tokens} tokens — over the 2,000 budget`);
        }
        break;
      }
    }
    setBusyTool(null);
  };

  const run = () => {
    const text = task.trim();
    if (!text) return;
    setRunning(true);
    push({ kind: "task", text });
    setTask("");
    note("info", "no agent yet — the observe-decide-act loop lands in M9");
    setTimeout(() => setRunning(false), 500);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col bg-background">
        <PanelHeader
          tab={tab}
          cdp={cdp}
          hasEvents={events.length > 0}
          onClear={clear}
        />
        <Transcript events={events} />
        <Composer
          task={task}
          running={running}
          cdp={cdp}
          busyTool={busyTool}
          overlayOn={overlayOn}
          onChange={setTask}
          onRun={run}
          onStop={() => setRunning(false)}
          onTool={runTool}
        />
      </div>
    </TooltipProvider>
  );
}
