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
  /**
   * Why it ended, in the scorer's vocabulary. Naming the mode for every failure
   * is the point of the matrix: "unknown" tells you nothing about which of the
   * model, the endpoint or the page was at fault.
   */
  failure?: string;
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
  const maxRetries = opts.maxRateLimitRetries ?? 5;

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
  /** One nudge per stuck signature before the run is handed over. */
  let nudgedFor = "";
  /** Every fact extracted so far, in order, kept verbatim for the final answer. */
  const notes: string[] = [];
  let extractRepeats = 0;
  /** `fail` is challenged once before it is believed. */
  let challengedFail = false;
  /** A malformed decode is a provider flake; only a run of them is fatal. */
  let decodeRetries = 0;

  const finish = (
    status: RunStatus,
    answer = "",
    error?: string,
    failure?: string,
  ): RunOutcome => ({
    status,
    answer,
    steps,
    usage,
    ms: Date.now() - started,
    error,
    failure,
  });

  for (let n = 1; n <= opts.stepCap; n++) {
    if (opts.signal.aborted) return finish("stopped");
    steps = n;
    decodeRetries = 0;

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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts.signal.aborted) return finish("stopped");
      try {
        proposal = await propose({
          config: opts.config,
          task: opts.task,
          page,
          history,
          notes,
          correction,
          signal: opts.signal,
        });
        break;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === "aborted") return finish("stopped");

        // A 429 and a 5xx are both "come back shortly", and treating the second
        // as fatal turns a provider hiccup into a failed task — which then
        // reads as the agent being bad at the job.
        // A model that returns JSON off-schema once will usually return valid
        // JSON on the next try. Failing the whole task on the first bad decode
        // scores a provider hiccup as the agent being unable to do the job.
        if (err instanceof ProviderError && isMalformed(err) && decodeRetries < 2) {
          decodeRetries++;
          opts.onWait?.(500, "malformed reply — retrying");
          await sleep(500);
          continue;
        }

        if (err instanceof ProviderError && isTransient(err)) {
          if (attempt === maxRetries) {
            return finish(
              "error",
              "",
              `${err.message} Gave up after ${attempt + 1} attempts.`,
              failureFor(err),
            );
          }
          const wait =
            err.rateLimit?.retryAfterMs ??
            Math.min(2 ** attempt * 1000 + Math.random() * 1000, MAX_BACKOFF_MS);
          opts.onWait?.(wait, err.kind === "rate_limit" ? "rate limited" : `endpoint ${err.status ?? "error"}`);
          await sleep(wait);
          continue;
        }
        return finish("error", "", message(err), err instanceof ProviderError ? failureFor(err) : "unknown");
      }
    }
    if (!proposal) return finish("error", "", "no proposal");

    usage.prompt += proposal.usage.prompt;
    usage.completion += proposal.usage.completion;
    usage.cachedPrompt = (usage.cachedPrompt ?? 0) + proposal.cached;
    opts.onProposal(n, proposal);

    if (proposal.problem) {
      if (repaired) {
        // A model that keeps trying to finish without writing the answer down
        // has still done the work; the notes are that answer.
        if (isTerminal(proposal.action) && notes.length > 0) {
          opts.onStepEnd(n, "answering from NOTES", true);
          return finish("done", notes.join(" "));
        }
        opts.onStepEnd(n, proposal.problem, false);
        return finish("failed", "", proposal.problem, "invalid_index");
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
    const signature =
      `${page.url}|${page.viewport.scrollY}|${action.action}` +
      `|${action.index ?? ""}|${action.value ?? ""}`;
    recent.push(signature);
    if (recent.length > 6) recent.shift();
    const repeats = recent.filter((r) => r === signature).length;

    // Two identical choices means the element did nothing — a close button that
    // is not one, usually. Naming it and forbidding it recovers far more runs
    // than handing over does, so the nudge comes first and the handover only
    // if it does not take.
    if (repeats === 2 && !wall && action.action !== "ask" && nudgedFor !== signature) {
      nudgedFor = signature;
      correction =
        `${describeChoice(action)} did nothing — the page is unchanged. ` +
        "Do not choose it again. Pick a different element, or if the page is " +
        "already usable, get on with the task.";
      opts.onStepEnd(n, "no effect — trying something else", false);
      continue;
    }

    const stuck = repeats >= 3;

    // `extract` is exempt: repeating it has its own handling below, which ends
    // with the answer in hand rather than handing the task over.
    const handOff = (wall || stuck) && action.action !== "ask" && action.action !== "extract";

    if (handOff && handedOffFor !== signature) {
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
        return finish("needs_user", because, undefined, "needs_user");
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
        return finish("needs_user", action.value ?? "", undefined, "needs_user");
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

    // Giving up early is cheap for the model and expensive for the user, and it
    // often does it while its own reason names the next thing to try. One
    // challenge costs a step and recovers the run more often than not.
    if (action.action === "fail" && !challengedFail) {
      challengedFail = true;
      correction =
        `You said you cannot continue: "${action.value ?? action.reason}". ` +
        "You have plenty of steps left. Try the thing you just described, or " +
        "another route to it. Only use fail again if there is genuinely nothing left.";
      opts.onStepEnd(n, "gave up early — asked it to try again", false);
      continue;
    }

    if (isTerminal(action)) {
      // A run that gathered facts and then said nothing should still hand them
      // over; the notes are the work, and discarding them helps nobody.
      const answer = action.value?.trim() || notes.join(" ");
      opts.onStepEnd(n, action.action === "done" ? "task complete" : `gave up: ${answer}`, action.action === "done");
      return finish(
        action.action === "done" ? "done" : "failed",
        answer,
        undefined,
        action.action === "done" ? undefined : "agent_gave_up",
      );
    }

    if (action.action === "extract") {
      const answer = (action.value ?? "").trim();

      if (!answer) {
        correction =
          "extract needs the fact itself in value. Put the text you are taking " +
          "off the page there, or choose a different action.";
        opts.onStepEnd(n, "extracted nothing", false);
        continue;
      }

      // NOTES already shows it, so a repeat means the model is not moving on.
      // Push back rather than finish: an extraction is sometimes a statement of
      // intent, and ending here would lock that in as the answer. Only after it
      // insists is the collected set the best thing to return.
      if (notes.some((note) => squash(note) === squash(answer))) {
        if (extractRepeats >= 1) {
          opts.onStepEnd(n, "nothing new to extract — answering from NOTES", true);
          return finish("done", notes.join(" "));
        }
        extractRepeats++;
        correction =
          `NOTES already holds "${answer.slice(0, 160)}". ` +
          "If you have every fact the task asked for, use done now and write the " +
          "whole answer out of NOTES. If a fact is still missing, go and get it.";
        opts.onStepEnd(n, "already noted", false);
        continue;
      }

      extractRepeats = 0;
      notes.push(answer);
      history.push(historyLine(history.length + 1, action, `noted (${notes.length})`));
      opts.onStepEnd(n, `noted: ${answer.slice(0, 80)}`, true);
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

  return finish("step_cap", "", undefined, "step_cap");
}

/** A decode failure, which is worth one more roll of the dice. */
function isMalformed(err: ProviderError): boolean {
  return err.kind === "invalid_json" || err.kind === "schema_invalid";
}

/** Worth waiting out rather than failing the task over. */
function isTransient(err: ProviderError): boolean {
  if (err.kind === "rate_limit") return true;
  return err.kind === "http" && err.status !== undefined && err.status >= 500;
}

/** Translates a provider failure into the scorer's vocabulary. */
function failureFor(err: ProviderError): string {
  switch (err.kind) {
    case "rate_limit": return "rate_limit";
    case "truncated": return "truncated";
    case "schema_rejected": return "schema_rejection";
    case "schema_invalid":
    case "invalid_json": return "schema_invalid";
    case "network":
    case "not_json":
    case "bad_key":
    case "not_configured":
    case "http": return "provider_error";
    default: return "unknown";
  }
}

/** Names the action that did nothing, in the model's own vocabulary. */
function describeChoice(action: AgentAction): string {
  if (action.index !== null && action.index !== undefined) {
    return `Element [${action.index}]`;
  }
  return `That ${action.action}`;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
