import type { Command } from "@/lib/commands";
import type { PageIndex } from "@/lib/page-index";
import { ProviderError, type ProviderConfig, type TokenUsage } from "@/lib/provider";
import { propose, toCommand, type Proposal } from "./index";
import { historyLine, type HistoryEntry } from "./prompt";
import { isTerminal, type AgentAction } from "./schema";

export type RunStatus =
  | "done"
  | "failed"
  | "stopped"
  | "step_cap"
  | "needs_user"
  | "error";

export interface AskRequest {
  question: string;
  /** Why the loop believes it cannot proceed alone. */
  because: string;
  url: string;
}

export interface AskReply {
  /** continue: the user dealt with it. skip: carry on without. stop: end the run. */
  action: "continue" | "skip" | "stop";
  /** Anything the user wants the agent to know, e.g. "signed in as me". */
  note: string;
}

export interface RunOutcome {
  status: RunStatus;
  /** The agent's own final answer, when it produced one. */
  answer: string;
  steps: number;
  usage: TokenUsage;
  ms: number;
  error?: string;
}

export interface ExecuteResult {
  ok: boolean;
  /** One short line, which becomes the history entry for this step. */
  summary: string;
}

export interface LoopDeps {
  /** Observe. Returns the page as the model will be shown it. */
  readPage: () => Promise<PageIndex>;
  /** Act. Only called for actions that touch the page. */
  execute: (command: Command, action: AgentAction) => Promise<ExecuteResult>;
  onStepStart: (n: number, page: PageIndex) => void;
  onProposal: (n: number, proposal: Proposal) => void;
  onStepEnd: (n: number, outcome: string, ok: boolean) => void;
  /**
   * Hands control to the human and waits. The loop simply awaits this, so a
   * pause needs no state machine — and a caller with no human present (the
   * scoring harness) answers "stop" immediately.
   */
  onAsk: (request: AskRequest) => Promise<AskReply>;
  /** Rate-limit waits are long enough that they have to be visible. */
  onWait?: (ms: number, why: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface LoopOptions extends LoopDeps {
  task: string;
  config: ProviderConfig;
  stepCap: number;
  signal: AbortSignal;
  /** Attempts to survive a 429 before giving up on the step. */
  maxRateLimitRetries?: number;
  /** Returns why this page needs a human, or null. */
  detectWall?: (page: PageIndex) => string | null;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Observe, decide, act — until the agent says it is finished, the step cap is
 * reached, or the user stops it.
 *
 * Dependencies are injected rather than reached for, so the parts that decide
 * whether this behaves correctly — the cap, stopping, recovery from a bad index,
 * surviving a 429 — can be tested without a browser or a model.
 */
export async function runLoop(opts: LoopOptions): Promise<RunOutcome> {
  const started = Date.now();
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRateLimitRetries = opts.maxRateLimitRetries ?? 3;

  const history: HistoryEntry[] = [];
  const usage: TokenUsage = { prompt: 0, completion: 0, cachedPrompt: 0 };

  let correction: string | undefined;
  /** One retry per step for a malformed choice, then the step fails. */
  let repaired = false;
  let steps = 0;

  // Loop detection. Small models repeat a useless action indefinitely, which on
  // a wall like a sign-in page looks locally reasonable every single time.
  const recent: string[] = [];
  let handedOffFor = "";

  const finish = (status: RunStatus, answer = "", error?: string): RunOutcome => ({
    status,
    answer,
    steps,
    usage,
    ms: Date.now() - started,
    error,
  });

  for (let n = 1; n <= opts.stepCap; n++) {
    if (opts.signal.aborted) return finish("stopped");
    steps = n;

    let page: PageIndex;
    try {
      page = await opts.readPage();
    } catch (err) {
      return finish("error", "", message(err));
    }
    if (opts.signal.aborted) return finish("stopped");
    opts.onStepStart(n, page);

    // Decide, surviving a rate limit rather than dying on it. Free tiers are
    // tight enough that a 429 mid-run is routine, not exceptional.
    let proposal: Proposal | null = null;
    for (let attempt = 0; attempt <= maxRateLimitRetries; attempt++) {
      if (opts.signal.aborted) return finish("stopped");
      try {
        proposal = await propose({
          config: opts.config,
          task: opts.task,
          page,
          history,
          correction,
          signal: opts.signal,
        });
        break;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === "aborted") return finish("stopped");
        if (err instanceof ProviderError && err.kind === "rate_limit") {
          if (attempt === maxRateLimitRetries) {
            return finish("error", "", `${err.message} Gave up after ${attempt + 1} attempts.`);
          }
          // The provider's own retry-after beats guessing; back off with jitter
          // only when it does not say.
          const wait =
            err.rateLimit?.retryAfterMs ??
            Math.min(2 ** attempt * 1000 + Math.random() * 1000, MAX_BACKOFF_MS);
          opts.onWait?.(wait, "rate limited");
          await sleep(wait);
          continue;
        }
        return finish("error", "", message(err));
      }
    }
    if (!proposal) return finish("error", "", "no proposal");

    usage.prompt += proposal.usage.prompt;
    usage.completion += proposal.usage.completion;
    usage.cachedPrompt = (usage.cachedPrompt ?? 0) + proposal.cached;
    opts.onProposal(n, proposal);

    if (proposal.problem) {
      if (repaired) {
        opts.onStepEnd(n, proposal.problem, false);
        return finish("failed", "", proposal.problem);
      }
      // Re-prompt with the concrete correction rather than narrating the error
      // in prose. The step is retried, not consumed.
      repaired = true;
      correction = `${proposal.problem}. Choose again using only the listed numbers.`;
      opts.onStepEnd(n, `invalid — retrying (${proposal.problem})`, false);
      n--;
      continue;
    }

    repaired = false;
    correction = undefined;
    const { action } = proposal;

    // Ask before acting, so a wall the agent cannot pass is handed over rather
    // than hammered at until the step cap.
    const wall = opts.detectWall?.(page) ?? null;
    const signature = `${page.url}|${action.action}|${action.index ?? ""}|${action.value ?? ""}`;
    recent.push(signature);
    if (recent.length > 3) recent.shift();
    const stuck = recent.length === 3 && new Set(recent).size === 1;

    if ((wall || stuck) && action.action !== "ask" && handedOffFor !== signature) {
      handedOffFor = signature;
      recent.length = 0;

      const because = wall ?? "The same action has been chosen three times without progress.";
      const reply = await opts.onAsk({
        question: wall
          ? "Tiny cannot sign in for you. Log in in the tab, then continue."
          : "Tiny appears to be stuck. Take a look, then tell it how to proceed.",
        because,
        url: page.url,
      });

      if (reply.action === "stop") {
        opts.onStepEnd(n, `handed over: ${because}`, false);
        return finish("needs_user", because);
      }

      history.push({
        n: history.length + 1,
        action: "asked the user",
        outcome:
          reply.action === "continue"
            ? `user handled it${reply.note ? `: ${reply.note}` : ""}`
            : `user said to skip${reply.note ? `: ${reply.note}` : ""}`,
      });
      opts.onStepEnd(n, reply.action === "continue" ? "user handled it" : "skipped", true);
      // Re-read from scratch: the user has probably changed the page.
      continue;
    }

    if (action.action === "ask") {
      const reply = await opts.onAsk({
        question: action.value ?? "Tiny needs your help.",
        because: action.reason,
        url: page.url,
      });

      if (reply.action === "stop") {
        opts.onStepEnd(n, "handed over to you", false);
        return finish("needs_user", action.value ?? "");
      }
      history.push(
        historyLine(
          history.length + 1,
          action,
          reply.action === "continue"
            ? `user handled it${reply.note ? `: ${reply.note}` : ""}`
            : `user said to skip${reply.note ? `: ${reply.note}` : ""}`,
        ),
      );
      opts.onStepEnd(n, reply.action === "continue" ? "user handled it" : "skipped", true);
      continue;
    }

    if (isTerminal(action)) {
      const answer = action.value ?? "";
      opts.onStepEnd(n, action.action === "done" ? "task complete" : `gave up: ${answer}`, action.action === "done");
      return finish(action.action === "done" ? "done" : "failed", answer);
    }

    if (action.action === "extract") {
      // Not terminal: it puts a fact into history for later steps to use.
      const answer = action.value ?? "";
      history.push(historyLine(history.length + 1, action, `noted: ${answer.slice(0, 120)}`));
      opts.onStepEnd(n, `extracted: ${answer.slice(0, 80)}`, true);
      continue;
    }

    const command = toCommand(action);
    if (!command) {
      opts.onStepEnd(n, `no command for ${action.action}`, false);
      return finish("error", "", `cannot execute ${action.action}`);
    }

    if (opts.signal.aborted) return finish("stopped");

    let result: ExecuteResult;
    try {
      result = await opts.execute(command, action);
    } catch (err) {
      return finish("error", "", message(err));
    }

    history.push(historyLine(history.length + 1, action, result.summary));
    opts.onStepEnd(n, result.summary, result.ok);

    if (opts.signal.aborted) return finish("stopped");
  }

  return finish("step_cap");
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
