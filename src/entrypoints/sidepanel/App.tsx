import { useCallback, useEffect, useRef, useState } from "react";
import { Composer, type ToolId } from "@/components/Composer";
import { PanelHeader } from "@/components/PanelHeader";
import { SettingsView } from "@/components/SettingsView";
import { Transcript } from "@/components/Transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PANEL_PORT, sendToBackground, type PanelMessage } from "@/lib/messaging";
import { COMMAND_HELP, parseCommand } from "@/lib/commands";
import { estimateTokens, serializeIndex } from "@/lib/page-index";
import { usePanel } from "@/lib/store";
import {
  DEFAULT_CONFIG,
  hasHostPermission,
  loadConfig,
  requestHostPermission,
  validateConfig,
  type ProviderConfig,
} from "@/lib/provider";
import {
  describeAction,
  detectAuthWall,
  historyLine,
  isTerminal,
  propose,
  toCommand,
  unreadablePage,
  type HistoryEntry,
  type Proposal,
} from "@/lib/agent";
import {
  runLoop,
  type ApprovalRequest,
  type AskReply,
  type AskRequest,
  type ExecuteResult,
} from "@/lib/agent/loop";
import {
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  saveAgentSettings,
  type AgentSettings,
} from "@/lib/settings";
import type { PageIndex } from "@/lib/page-index";
import type { Command } from "@/lib/commands";
import {
  DEFAULT_BRIDGE,
  backendToConfig,
  bridgeHealthy,
  nextTask,
  postResult,
  type BenchStep,
} from "@/lib/bench";
import { BenchBar, type BenchState } from "@/components/BenchBar";

/** Maps the loop's own status onto the harness's failure taxonomy. */
function failureFor(status: string): string | undefined {
  switch (status) {
    case "done": return undefined;
    case "step_cap": return "step_cap";
    case "stopped": return "agent_gave_up";
    case "needs_user": return "needs_user";
    case "failed": return "agent_gave_up";
    default: return "unknown";
  }
}

const TOOL_MESSAGE: Record<ToolId, PanelMessage> = {
  attach: { kind: "cdpAttach" },
  detach: { kind: "cdpDetach" },
  capture: { kind: "cdpScreenshot" },
  index: { kind: "buildIndex" },
  overlay: { kind: "overlay", on: true },
  cursor: { kind: "cursor", on: true },
  bench: { kind: "ping", sentAt: 0 },
  ping: { kind: "ping", sentAt: 0 },
  tab: { kind: "activeTab" },
  page: { kind: "probePage" },
};

export function App() {
  const {
    task, running, tab, cdp, events,
    setTask, setRunning, setTab, setCdp, note, push, patchStep, answerAsk, answerApproval,
    resolveProposal, clear,
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
  const [agent, setAgent] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const runAbort = useRef<AbortController | null>(null);
  // Resolved by the AskCard's buttons. The loop is just awaiting this promise,
  // so a paused run needs no state machine.
  const askResolver = useRef<((reply: AskReply) => void) | null>(null);
  const approvalResolver = useRef<((allowed: boolean) => void) | null>(null);
  const [bench, setBench] = useState<BenchState>({
    on: false,
    connected: false,
    current: null,
    completed: 0,
    lastError: null,
  });
  // Read by the polling effect without making it re-subscribe on every render.
  const benchBusy = useRef(false);
  const latest = useRef({ provider, agent, targetTabId, cursorOn });
  latest.current = { provider, agent, targetTabId, cursorOn };

  useEffect(() => {
    void loadAgentSettings().then(setAgent);
  }, []);

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
    if (tool === "bench") {
      if (bench.on) {
        setBench((b) => ({ ...b, on: false, current: null, lastError: null }));
        return;
      }
      // This click is the user gesture Chrome requires for a permission request.
      const granted =
        (await hasHostPermission(DEFAULT_BRIDGE)) ||
        (await requestHostPermission(DEFAULT_BRIDGE));
      if (!granted) {
        note("error", `Benchmark needs permission to reach ${DEFAULT_BRIDGE}`);
        return;
      }
      setBench((b) => ({ ...b, on: true, current: null, lastError: null }));
      return;
    }
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
    // A run paused on a question is not inside the loop's abort checks, so the
    // pending promise has to be released or Stop would do nothing.
    askResolver.current?.({ action: "stop", note: "" });
    approvalResolver.current?.(false);
    // Two halves: the panel-side loop stops between steps, and the background
    // aborts whatever action or request is already in flight.
    runAbort.current?.abort();
    const reply = await sendToBackground({ kind: "abort", tabId: targetTabId });
    if (reply.ok && reply.kind === "abort" && !reply.stopped && !runAbort.current) {
      setRunning(false);
    }
  };

  /**
   * Pauses the run and waits for the person.
   *
   * A scored run has nobody watching, so it stops rather than hanging forever —
   * a task that needs a human is a real result, not a timeout.
   */
  const askUser = (request: AskRequest, unattended: boolean): Promise<AskReply> => {
    if (unattended) {
      push({ kind: "ask", request, answer: { action: "stop", note: "unattended run" } });
      return Promise.resolve({ action: "stop", note: "unattended run" });
    }

    push({ kind: "ask", request, answer: null });
    const id = usePanel.getState().events.at(-1)?.id ?? null;
    setRunning(false);

    return new Promise<AskReply>((resolve) => {
      askResolver.current = (reply) => {
        askResolver.current = null;
        if (id !== null) answerAsk(id, reply);
        setRunning(true);
        resolve(reply);
      };
    });
  };

  const answerAskRequest = (_id: number, reply: AskReply) => {
    askResolver.current?.(reply);
  };

  /**
   * Holds the run until you decide.
   *
   * Refuses outright when nobody is watching — a scored run has no human to
   * click Allow, and defaulting the other way would mean the benchmark could
   * place an order.
   */
  const askApproval = (request: ApprovalRequest, unattended: boolean): Promise<boolean> => {
    if (unattended) {
      push({ kind: "approval", request, answer: false });
      return Promise.resolve(false);
    }

    push({ kind: "approval", request, answer: null });
    const id = usePanel.getState().events.at(-1)?.id ?? null;
    setRunning(false);

    return new Promise<boolean>((resolve) => {
      approvalResolver.current = (allowed) => {
        approvalResolver.current = null;
        if (id !== null) answerApproval(id, allowed);
        setRunning(true);
        resolve(allowed);
      };
    });
  };

  const answerApprovalRequest = (_id: number, allowed: boolean) => {
    approvalResolver.current?.(allowed);
  };

  /** Runs one action through the actuation layer and reports it back to the loop. */

  /**
   * Polls the harness for work while benchmarking.
   *
   * One task at a time and never concurrently — the suite scores wall clock, so
   * two runs sharing a browser would corrupt every number it records.
   */
  useEffect(() => {
    if (!bench.on) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled || benchBusy.current) return;

      const healthy = await bridgeHealthy(DEFAULT_BRIDGE);
      setBench((b) => (b.connected === healthy ? b : { ...b, connected: healthy }));
      if (!healthy || cancelled) return;

      let job;
      try {
        job = await nextTask(DEFAULT_BRIDGE);
      } catch (err) {
        setBench((b) => ({ ...b, lastError: err instanceof Error ? err.message : String(err) }));
        return;
      }
      if (!job || cancelled) return;

      benchBusy.current = true;
      setBench((b) => ({ ...b, current: `${job.id} — ${job.task.slice(0, 48)}`, lastError: null }));
      note("info", `bench: ${job.task}`);

      try {
        const config = backendToConfig(job, latest.current.provider);
        const result = await runAutonomously(job.task, {
          config,
          stepCap: job.stepCap,
          startUrl: job.startUrl,
        });

        await postResult(DEFAULT_BRIDGE, job.id, {
          answer: result?.outcome.answer ?? "",
          completed: result?.outcome.status === "done",
          finalUrl: result?.finalUrl ?? "",
          steps: result?.steps ?? [],
          // The loop names the mode when it knows it; the status is only a
          // fallback for the cases it does not.
          failure: result
            ? (result.outcome.failure ?? failureFor(result.outcome.status))
            : "driver_error",
          error: result?.outcome.error,
        });
        setBench((b) => ({ ...b, completed: b.completed + 1 }));
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        setBench((b) => ({ ...b, lastError: text }));
        await postResult(DEFAULT_BRIDGE, job.id, {
          answer: "", completed: false, finalUrl: "", steps: [],
          failure: "driver_error", error: text,
        }).catch(() => {});
      } finally {
        benchBusy.current = false;
        setBench((b) => ({ ...b, current: null }));
      }
    };

    const timer = setInterval(() => void tick(), 1200);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bench.on]);

  const executeCommand = async (
    command: Command,
    showCursor = true,
  ): Promise<ExecuteResult> => {
    const reply = await sendToBackground({
      kind: "command",
      command,
      // The cursor animation adds ~400ms per click; a scored run should not
      // pay for it.
      cursor: showCursor && cursorOn,
      tabId: targetTabId,
    });
    if (!reply.ok) return { ok: false, summary: reply.error };
    if (reply.kind !== "command") return { ok: false, summary: "unexpected reply" };

    setOverlayOn(reply.overlayOn);
    if (reply.tabId) setTargetTabId(reply.tabId);
    return { ok: true, summary: reply.result.summary };
  };

  const runAutonomously = async (
    goalText: string,
    override?: { config: ProviderConfig; stepCap: number; startUrl: string | null },
  ) => {
    const config = override?.config ?? provider;
    const stepCap = override?.stepCap ?? agent.stepCap;

    if (validateConfig(config).length > 0) {
      note("error", "No model configured yet — open settings and add one.");
      if (!override) setSettingsOpen(true);
      return null;
    }

    const controller = new AbortController();
    runAbort.current = controller;
    setRunning(true);

    const current = await refresh();
    const tabId = current?.id ?? targetTabId;

    // The harness pins a starting page so every attempt begins identically.
    if (override?.startUrl && override.startUrl !== "about:blank") {
      await sendToBackground({
        kind: "command",
        command: { kind: "goto", url: override.startUrl },
        cursor: false,
        tabId,
      });
    }

    await sendToBackground({ kind: "runStart", tabId });
    const collected: BenchStep[] = [];
    let lastUrl = current?.url ?? "";

    // The step card is written before the outcome is known, then patched, so
    // the panel shows what is happening rather than what already happened.
    let stepId: number | null = null;

    try {
      const outcome = await runLoop({
        task: goalText,
        config,
        stepCap,
        signal: controller.signal,
        readPage: async () => {
          const page = await readPage();
          if (!page) throw new Error("could not read the page");
          return page;
        },
        execute: (command) => executeCommand(command, !override),
        detectWall: detectAuthWall,
        onAsk: (request) => askUser(request, Boolean(override)),
        onApprove: (request) => askApproval(request, Boolean(override)),
        routes: agent.routes,
        firewall: agent.firewall,
        plan: agent.plan,
        validate: agent.validate,
        startUrl: override?.startUrl ?? current?.url ?? "",
        onPlan: (made, replannedNow) =>
          push({
            kind: "plan",
            steps: made.steps,
            watchOut: made.watch_out,
            replanned: replannedNow,
          }),
        onVerdict: (met, why) => push({ kind: "verdict", met, why }),
        onStepStart: (n, page) => {
          lastUrl = page.url;
          collected.push({
            n,
            url: page.url,
            action: "",
            reason: "",
            indexSize: page.elements.length,
            usage: { prompt: 0, completion: 0 },
            requestMs: 0,
          });
          push({
            kind: "step",
            n,
            url: page.url,
            title: page.title,
            indexSize: page.elements.length,
            totalFound: page.totalFound,
            action: null,
            usage: null,
            cached: 0,
            thinkMs: 0,
            outcome: "",
            state: "thinking",
          });
          stepId = usePanel.getState().events.at(-1)?.id ?? null;
        },
        onProposal: (n, proposal) => {
          const record = collected[n - 1];
          if (record) {
            record.action = describeAction(proposal.action);
            record.reason = proposal.action.reason;
            record.usage = proposal.usage;
            record.requestMs = proposal.requestMs;
            record.promptMs = proposal.timings.promptMs;
            record.completionMs = proposal.timings.completionMs;
          }
          if (stepId === null) return;
          patchStep(stepId, {
            action: proposal.action,
            usage: proposal.usage,
            cached: proposal.cached,
            thinkMs: proposal.requestMs,
            state: "acting",
          });
        },
        onStepEnd: (n, outcomeText, ok) => {
          const record = collected[n - 1];
          if (record) record.outcome = outcomeText;
          if (record && !ok) record.error = outcomeText;
          if (stepId === null) return;
          patchStep(stepId, { outcome: outcomeText, state: ok ? "ok" : "bad" });
        },
        onWait: (ms, why) => note("info", `${why} — waiting ${Math.round(ms / 1000)}s`),
      });

      push({ kind: "summary", outcome, task: goalText });
      const after = await refresh();
      return { outcome, steps: collected, finalUrl: after?.url ?? lastUrl };
    } catch (err) {
      note("error", err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      await sendToBackground({ kind: "runEnd", tabId });
      runAbort.current = null;
      setRunning(false);
      setGoal(null);
      await refresh();
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
      setHistory([]);

      if (agent.autoRun) {
        await runAutonomously(text);
        return;
      }
      setGoal(text);
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
          agent={agent}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next, nextAgent) => {
            setProvider(next);
            setAgent(nextAgent);
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
        <BenchBar
          state={bench}
          onToggle={() => setBench((b) => ({ ...b, on: false, current: null }))}
        />
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
          onAnswerAsk={answerAskRequest}
          onAnswerApproval={answerApprovalRequest}
        />
        <Composer
          task={task}
          running={running}
          cdp={cdp}
          busyTool={busyTool}
          overlayOn={overlayOn}
          cursorOn={cursorOn}
          canContinue={goal !== null && pending === null}
          autoRun={agent.autoRun}
          onToggleAuto={() => {
            const next = { ...agent, autoRun: !agent.autoRun };
            setAgent(next);
            void saveAgentSettings(next);
          }}
          onChange={setTask}
          onRun={() => void run()}
          onStop={() => void stop()}
          onTool={runTool}
        />
      </div>
    </TooltipProvider>
  );
}
