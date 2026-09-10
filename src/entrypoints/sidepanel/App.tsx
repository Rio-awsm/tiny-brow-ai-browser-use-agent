import { useCallback, useEffect, useState } from "react";
import { Composer, type ToolId } from "@/components/Composer";
import { PanelHeader } from "@/components/PanelHeader";
import { SettingsView } from "@/components/SettingsView";
import { Transcript } from "@/components/Transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PANEL_PORT, sendToBackground, type PanelMessage } from "@/lib/messaging";
import { COMMAND_HELP, parseCommand } from "@/lib/commands";
import { estimateTokens, serializeIndex } from "@/lib/page-index";
import { usePanel } from "@/lib/store";
import { DEFAULT_CONFIG, loadConfig, validateConfig, type ProviderConfig } from "@/lib/provider";
import {
  historyLine,
  isTerminal,
  propose,
  toCommand,
  unreadablePage,
  type HistoryEntry,
  type Proposal,
} from "@/lib/agent";
import type { PageIndex } from "@/lib/page-index";

const TOOL_MESSAGE: Record<ToolId, PanelMessage> = {
  attach: { kind: "cdpAttach" },
  detach: { kind: "cdpDetach" },
  capture: { kind: "cdpScreenshot" },
  index: { kind: "buildIndex" },
  overlay: { kind: "overlay", on: true },
  cursor: { kind: "cursor", on: true },
  ping: { kind: "ping", sentAt: 0 },
  tab: { kind: "activeTab" },
  page: { kind: "probePage" },
};

export function App() {
  const {
    task, running, tab, cdp, events,
    setTask, setRunning, setTab, setCdp, note, push, resolveProposal, clear,
  } = usePanel();
  const [busyTool, setBusyTool] = useState<ToolId | null>(null);
  const [overlayOn, setOverlayOn] = useState(false);
  const [cursorOn, setCursorOn] = useState(true);
  // The tab Tiny is driving. It follows the active tab while idle, and a newtab
  // command retargets it, so a run always names the page it means.
  const [targetTabId, setTargetTabId] = useState<number | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderConfig>(DEFAULT_CONFIG);
  // One task at a time, with the history the next proposal will be given.
  const [goal, setGoal] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pending, setPending] = useState<{ id: number; proposal: Proposal } | null>(null);

  useEffect(() => {
    void loadConfig().then(setProvider);
  }, []);

  // A preference, so it outlives the panel rather than resetting every time it
  // is reopened.
  useEffect(() => {
    chrome.storage.local.get("cursorOn").then((v) => {
      if (typeof v.cursorOn === "boolean") setCursorOn(v.cursorOn);
    });
  }, []);

  const refresh = useCallback(
    async (tabId?: number) => {
      const tabReply = await sendToBackground({ kind: "activeTab", tabId });
      if (!tabReply.ok || tabReply.kind !== "activeTab") return null;
      setTab(tabReply.tab);
      setTargetTabId(tabReply.tab?.id);

      const cdpReply = await sendToBackground({ kind: "cdpStatus", tabId: tabReply.tab?.id });
      if (cdpReply.ok && cdpReply.kind === "cdpStatus") setCdp(cdpReply.status);
      return tabReply.tab;
    },
    [setTab, setCdp],
  );

  // A navigation destroys the overlay along with the page it was drawn on, so
  // the toggle has to follow the URL rather than remember what the user clicked.
  useEffect(() => {
    setOverlayOn(false);
  }, [tab?.url, tab?.id]);

  // Held open for as long as the panel is on screen. If it closes mid-run the
  // background sees the disconnect and releases the debugger, rather than
  // leaving the banner over a page nobody is driving.
  useEffect(() => {
    const port = chrome.runtime.connect({ name: PANEL_PORT });
    return () => port.disconnect();
  }, []);

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
          : tool === "cursor"
            ? { kind: "cursor" as const, on: !cursorOn }
            : TOOL_MESSAGE[tool];
    note("sent", `${tool} → background`);

    const reply = await sendToBackground({ ...msg, tabId: targetTabId });

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
      case "command":
        push({ kind: "action", result: reply.result });
        if (reply.index) push({ kind: "index", index: reply.index });
        setOverlayOn(reply.overlayOn);
        break;
      case "cursor":
        setCursorOn(reply.on);
        void chrome.storage.local.set({ cursorOn: reply.on });
        note("recv", reply.on ? "cursor shown" : "cursor hidden");
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

  const runCommand = async (input: string) => {
    const parsed = parseCommand(input);
    if (!parsed) return false;

    push({ kind: "command", input });
    setTask("");

    if (!parsed.ok) {
      note("error", parsed.error);
      return true;
    }

    if (parsed.command.kind === "help") {
      push({ kind: "help", text: COMMAND_HELP });
      return true;
    }
    if (parsed.command.kind === "index") {
      await runTool("index");
      return true;
    }

    setRunning(true);
    const reply = await sendToBackground({
      kind: "command",
      command: parsed.command,
      cursor: cursorOn,
      tabId: targetTabId,
    });
    if (!reply.ok) {
      if (reply.error === "stopped") note("info", "stopped");
      else note("error", reply.error);
      await refresh();
    } else if (reply.kind === "command") {
      push({ kind: "action", result: reply.result });
      if (reply.index) push({ kind: "index", index: reply.index });
      setOverlayOn(reply.overlayOn);
      // A navigation, or a hop to a new tab, changes what is possible here; do
      // not wait for the poll to notice.
      await refresh(reply.tabId);
    }
    setRunning(false);
    return true;
  };

  const stop = async () => {
    const reply = await sendToBackground({ kind: "abort", tabId: targetTabId });
    if (reply.ok && reply.kind === "abort" && !reply.stopped) {
      // Nothing was mid-flight; drop the busy state so the button is honest.
      setRunning(false);
    }
  };

  /** Reads the page the proposal will be made against. */
  const readPage = async (): Promise<PageIndex | null> => {
    // A page Chrome will not let us attach to is not a failure — the model can
    // still choose to navigate away from it, so hand it a page that says so.
    const status = await sendToBackground({ kind: "cdpStatus", tabId: targetTabId });
    if (status.ok && status.kind === "cdpStatus" && status.status.state === "restricted") {
      setCdp(status.status);
      return unreadablePage(
        status.status.url,
        tab?.title ?? "",
        status.status.reason ?? "Chrome blocks extensions here.",
      );
    }

    const reply = await sendToBackground({ kind: "buildIndex", tabId: targetTabId });
    if (!reply.ok) {
      note("error", reply.error);
      return null;
    }
    if (reply.kind !== "buildIndex") return null;
    setCdp(reply.status);
    return reply.index;
  };

  const askForAction = async (
    forGoal: string,
    forHistory: HistoryEntry[],
    correction?: string,
  ) => {
    if (validateConfig(provider).length > 0) {
      note("error", "No model configured yet — open settings and add one.");
      setSettingsOpen(true);
      return;
    }

    setRunning(true);
    try {
      const page = await readPage();
      if (!page) return;
      push({ kind: "index", index: page });

      const proposal = await propose({
        config: provider,
        task: forGoal,
        page,
        history: forHistory,
        correction,
      });

      push({ kind: "proposal", proposal, state: "pending" });
      // The store stamps the id, so read back the one it assigned.
      const written = usePanel.getState().events.at(-1);
      if (written) setPending({ id: written.id, proposal });
    } catch (err) {
      note("error", err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const executeProposal = async (id: number) => {
    if (!pending || pending.id !== id) return;
    const { proposal } = pending;
    const command = toCommand(proposal.action);

    resolveProposal(id, "executed");
    setPending(null);

    let outcome = "no page action";
    if (command) {
      setRunning(true);
      const reply = await sendToBackground({
        kind: "command",
        command,
        cursor: cursorOn,
        tabId: targetTabId,
      });
      setRunning(false);

      if (!reply.ok) {
        outcome = `failed: ${reply.error}`;
        note("error", reply.error);
      } else if (reply.kind === "command") {
        outcome = reply.result.summary;
        push({ kind: "action", result: reply.result });
        setOverlayOn(reply.overlayOn);
        await refresh(reply.tabId);
      }
    } else if (isTerminal(proposal.action)) {
      outcome = "answered";
    }

    const next = [...history, historyLine(history.length + 1, proposal.action, outcome)];
    setHistory(next);

    if (isTerminal(proposal.action)) {
      note("info", proposal.action.action === "done" ? "task complete" : "agent gave up");
      setGoal(null);
      return;
    }
    // M8 is one step at a time on purpose: the human is the loop until M9.
    note("info", "step recorded — press Run to ask for the next action");
  };

  const rejectProposal = async (id: number) => {
    if (!pending || pending.id !== id) return;
    const rejected = pending.proposal;
    resolveProposal(id, "rejected");
    setPending(null);

    if (!goal) return;
    await askForAction(
      goal,
      history,
      rejected.problem
        ? `Your last choice was rejected: ${rejected.problem}. Choose a different action.`
        : `The user rejected "${rejected.action.action}". Propose a different action, not the same one again.`,
    );
  };

  const run = async () => {
    const text = task.trim();

    if (text && (await runCommand(text))) return;

    if (text) {
      push({ kind: "task", text });
      setTask("");
      setGoal(text);
      setHistory([]);
      await askForAction(text, []);
      return;
    }

    // Empty input with a task in flight means "next step".
    if (goal) await askForAction(goal, history);
  };

  if (settingsOpen) {
    return (
      <TooltipProvider delayDuration={300}>
        <SettingsView
          config={provider}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setProvider(next);
            note("info", `model set to ${next.model}`);
            setSettingsOpen(false);
          }}
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col bg-background">
        <PanelHeader
          tab={tab}
          cdp={cdp}
          hasEvents={events.length > 0}
          providerReady={validateConfig(provider).length === 0}
          providerLabel={provider.model}
          onClear={clear}
          onSettings={() => setSettingsOpen(true)}
        />
        <Transcript
          events={events}
          busy={running}
          onExecute={(id) => void executeProposal(id)}
          onReject={(id) => void rejectProposal(id)}
        />
        <Composer
          task={task}
          running={running}
          cdp={cdp}
          busyTool={busyTool}
          overlayOn={overlayOn}
          cursorOn={cursorOn}
          canContinue={goal !== null && pending === null}
          onChange={setTask}
          onRun={() => void run()}
          onStop={() => void stop()}
          onTool={runTool}
        />
      </div>
    </TooltipProvider>
  );
}
