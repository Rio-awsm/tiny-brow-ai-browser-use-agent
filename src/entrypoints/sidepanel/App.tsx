import { useCallback, useEffect, useState } from "react";
import { ActivityLog } from "@/components/ActivityLog";
import { PanelHeader } from "@/components/PanelHeader";
import { ProbeBar } from "@/components/ProbeBar";
import { TaskComposer } from "@/components/TaskComposer";
import { ViewportCard } from "@/components/ViewportCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CdpStatus, Screenshot } from "@/lib/cdp-types";
import { sendToBackground, type PanelMessage } from "@/lib/messaging";
import { usePanel } from "@/lib/store";

type CdpBusy = "attach" | "detach" | "capture" | null;

export function App() {
  const { task, running, tab, log, setTask, setRunning, setTab, append, clearLog } =
    usePanel();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cdp, setCdp] = useState<CdpStatus | null>(null);
  const [cdpBusy, setCdpBusy] = useState<CdpBusy>(null);
  const [shot, setShot] = useState<Screenshot | null>(null);

  const refresh = useCallback(async () => {
    const tabReply = await sendToBackground({ kind: "activeTab" });
    if (!tabReply.ok || tabReply.kind !== "activeTab") {
      setConnected(false);
      return null;
    }
    setConnected(true);
    setTab(tabReply.tab);

    const cdpReply = await sendToBackground({ kind: "cdpStatus" });
    if (cdpReply.ok && cdpReply.kind === "cdpStatus") setCdp(cdpReply.status);
    return tabReply.tab;
  }, [setTab]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    chrome.tabs.onUpdated.addListener(onChange);
    chrome.tabs.onActivated.addListener(onChange);
    chrome.tabs.onRemoved.addListener(onChange);

    // Chrome can end a debugger session without telling the panel, and the
    // background worker can be evicted mid-session. Polling keeps the badge
    // honest rather than showing whatever was true when the panel last acted.
    const poll = setInterval(onChange, 2500);

    return () => {
      chrome.tabs.onUpdated.removeListener(onChange);
      chrome.tabs.onActivated.removeListener(onChange);
      chrome.tabs.onRemoved.removeListener(onChange);
      clearInterval(poll);
    };
  }, [refresh]);

  const ping = async () => {
    setBusy(true);
    append("sent", "ping → background");
    console.log("[tiny-brow panel] -> ping");
    const reply = await sendToBackground({ kind: "ping", sentAt: Date.now() });
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
    const next = await refresh();
    append(next ? "recv" : "error", next ? `tab ${next.id} · ${next.url}` : "no active tab");
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
      append("error", reply.ok ? "unexpected reply" : `probe failed: ${reply.error}`);
    }
    setBusy(false);
  };

  const cdpAction = async (
    mode: Exclude<CdpBusy, null>,
    msg: PanelMessage,
    label: string,
  ) => {
    setCdpBusy(mode);
    append("sent", label);
    const reply = await sendToBackground(msg);

    if (!reply.ok) {
      append("error", reply.error);
      // The failure itself changes the picture — a refused attach may mean the
      // page became restricted, or that something else holds the session.
      await refresh();
      setCdpBusy(null);
      return;
    }

    if (reply.kind === "cdpStatus") {
      setCdp(reply.status);
      append("recv", `debugger ${reply.status.state}`);
    } else if (reply.kind === "cdpScreenshot") {
      setCdp(reply.status);
      setShot(reply.shot);
      append(
        "recv",
        `captured ${reply.shot.width}×${reply.shot.height} · ${(reply.shot.bytes / 1024).toFixed(0)}kB · ${reply.shot.tookMs}ms`,
      );
    }
    setCdpBusy(null);
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
        <ViewportCard
          status={cdp}
          shot={shot}
          busy={cdpBusy}
          onAttach={() =>
            cdpAction("attach", { kind: "cdpAttach" }, "cdpAttach → background")
          }
          onDetach={() =>
            cdpAction("detach", { kind: "cdpDetach" }, "cdpDetach → background")
          }
          onCapture={() =>
            cdpAction("capture", { kind: "cdpScreenshot" }, "cdpScreenshot → background")
          }
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
