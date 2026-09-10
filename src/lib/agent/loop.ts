import type { Command } from "@/lib/commands";
import type { PageIndex } from "@/lib/page-index";
import { ProviderError, type ProviderConfig, type TokenUsage } from "@/lib/provider";
import { propose, toCommand, type Proposal } from "./index";
import { historyLine, type HistoryEntry } from "./prompt";
import { isTerminal, type AgentAction } from "./schema";

export type RunStatus = "done" | "failed" | "stopped" | "step_cap" | "error";

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
