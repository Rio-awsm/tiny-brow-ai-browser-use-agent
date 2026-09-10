import { useCallback, useEffect, useState } from "react";
import { ActivityLog } from "@/components/ActivityLog";
import { PanelHeader } from "@/components/PanelHeader";
import { ProbeBar } from "@/components/ProbeBar";
import { TaskComposer } from "@/components/TaskComposer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sendToBackground } from "@/lib/messaging";
import { usePanel } from "@/lib/store";

export function App() {
  const { task, running, tab, log, setTask, setRunning, setTab, append, clearLog } =
    usePanel();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshTab = useCallback(async () => {
    const reply = await sendToBackground({ kind: "activeTab" });
    if (reply.ok && reply.kind === "activeTab") {
      setTab(reply.tab);
      setConnected(true);
      return reply.tab;
    }
    setConnected(false);
    return null;
  }, [setTab]);

  useEffect(() => {
    void refreshTab();
    // The panel outlives navigations in the tab it is attached to, so the
    // header would otherwise show a stale URL for the rest of the session.
    const onUpdated = () => void refreshTab();
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onUpdated);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onUpdated);
    };
  }, [refreshTab]);

  const ping = async () => {
    setBusy(true);
    const sentAt = Date.now();
    append("sent", "ping → background");
    console.log("[tiny-brow panel] -> ping");
    const reply = await sendToBackground({ kind: "ping", sentAt });
    if (reply.ok && reply.kind === "pong") {
      const rtt = Date.now() - reply.sentAt;
      append("recv", `pong ← background (${rtt}ms round trip)`);
      console.log("[tiny-brow panel] <- pong", { rtt });
      setConnected(true);
    } else {
      append("error", `ping failed: ${reply.ok ? "unexpected reply" : reply.error}`);
      setConnected(false);
    }
    setBusy(false);
  };

  const probeTab = async () => {
    setBusy(true);
    append("sent", "activeTab → background");
    const next = await refreshTab();
    append(
      next ? "recv" : "error",
      next ? `tab ${next.id} · ${next.url}` : "no active tab",
    );
    setBusy(false);
  };

  const probePage = async () => {
    setBusy(true);
    append("sent", "probePage → background → content script");
    const reply = await sendToBackground({ kind: "probePage" });
    if (reply.ok && reply.kind === "probePage") {
      const p = reply.probe;
      append("recv", `${p.readyState} · ${p.elementCount} nodes · ${p.title}`);
    } else {
      append(
        "error",
        reply.ok ? "unexpected reply" : `probe failed: ${reply.error}`,
      );
    }
    setBusy(false);
  };

  const run = () => {
    setRunning(true);
    append("info", `task queued: ${task.trim()}`);
    append("info", "no agent yet — the observe-decide-act loop lands in M9");
    setTimeout(() => setRunning(false), 600);
  };

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full flex-col bg-background">
        <PanelHeader tab={tab} connected={connected} />
        <TaskComposer
          task={task}
          running={running}
          onChange={setTask}
          onRun={run}
          onStop={() => setRunning(false)}
        />
        <ActivityLog log={log} />
        <ProbeBar
          busy={busy}
          hasLog={log.length > 0}
          onPing={ping}
          onRefreshTab={probeTab}
          onProbePage={probePage}
          onClear={clearLog}
        />
      </div>
    </TooltipProvider>
  );
}
