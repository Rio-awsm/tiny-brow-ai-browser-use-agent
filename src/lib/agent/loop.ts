import type { Command } from "@/lib/commands";
import type { PageIndex } from "@/lib/page-index";
import { ProviderError, type ProviderConfig, type TokenUsage } from "@/lib/provider";
import { propose, toCommand, type Proposal } from "./index";
import { makePlan, type PlanResult } from "./planner";
import { configFor, type Routes } from "./roles";
import { gate, injectionSpans, DEFAULT_FIREWALL, type Firewall, type Judgement } from "./safety";
import { validateAnswer } from "./validator";
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

export interface ApprovalRequest {
  /** Plain description of the action, e.g. `Click button "Place order"`. */
  what: string;
  /** Why the gate stopped it. */
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
  /**
   * Holds an irreversible action until a human agrees to it. Defaults to a
   * refusal: an unattended run must never be able to spend money by having
   * nobody there to say no.
   */
  onApprove?: (request: ApprovalRequest) => Promise<boolean>;
  /** Told when a plan is written, so the panel can show it. */
  onPlan?: (plan: PlanResult, replanned: boolean) => void;
  /** Told what the validator decided about a `done`. */
  onVerdict?: (met: boolean, why: string) => void;
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
  /** Per-role model overrides. Every role falls back to `config`. */
  routes?: Routes;
  firewall?: Firewall;
  /** Write a plan before the first step, and again if the run gets stuck. */
  plan?: boolean;
  /** Second-opinion check on `done`. */
  validate?: boolean;
  /** Where the run begins, so the plan is not written blind. */
  startUrl?: string;
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
  /** Escape is tried once per run as a way out of an overlay. */
  let escaped = false;
  /** Every fact extracted so far, in order, kept verbatim for the final answer. */
  const notes: string[] = [];
  let extractRepeats = 0;
  /** `fail` is challenged once before it is believed. */
  let challengedFail = false;
  /** A malformed decode is a provider flake; only a run of them is fatal. */
  let decodeRetries = 0;
  /** One challenge per false `done`, then the answer is accepted as given. */
  let challengedDone = false;
  /**
   * The last answer the model actually composed.
   *
   * Joined notes are a floor, not a substitute: an answer the model wrote is a
   * sentence with a comparison in it, and "₹795 ₹709" is two numbers. Falling
   * back past one to the other threw away a correct answer once already.
   */
  let bestAnswer = "";

  const routes = opts.routes ?? {};
  const firewall = opts.firewall ?? DEFAULT_FIREWALL;
  const navigatorConfig = configFor(opts.config, routes, "navigator");
  const approve = opts.onApprove ?? (async () => false);

  // A box rather than a bare variable: the plan is written inside a closure,
  // and narrowing a `let` from its initialiser would type every later read as null.
  const plan: { current: PlanResult | null } = { current: null };
  let replanned = false;

  const writePlan = async (startUrl: string, trouble?: string) => {
    if (!opts.plan) return;
    try {
      plan.current = await makePlan({
        config: configFor(opts.config, routes, "planner"),
        task: opts.task,
        startUrl,
        trouble,
        signal: opts.signal,
      });
      usage.prompt += plan.current.usage.prompt;
      usage.completion += plan.current.usage.completion;
      opts.onPlan?.(plan.current, Boolean(trouble));
    } catch {
      // A plan is an accelerant, never a prerequisite. If the planner endpoint
      // is down the run still works, it just works less well.
    }
  };

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

  /**
   * Every route to a finished run passes through here.
   *
   * Returning null means the answer was challenged and the run continues, so
   * the check cannot be reached around by whichever branch decided it was done.
   */
  const concludeDone = async (answer: string, page: PageIndex, n: number): Promise<RunOutcome | null> => {
    if (!opts.validate || challengedDone) {
      opts.onStepEnd(n, "task complete", true);
      return finish("done", answer);
    }
    challengedDone = true;

    try {
      const check = await validateAnswer({
        config: configFor(opts.config, routes, "validator"),
        task: opts.task,
        answer,
        pageText: page.text,
        notes,
        signal: opts.signal,
      });
      usage.prompt += check.usage.prompt;
      usage.completion += check.usage.completion;
      opts.onVerdict?.(check.met, check.why);

      if (!check.met) {
        correction =
          `That answer was checked and rejected: ${check.why} ` +
          "Do not finish yet. Go and get what is actually missing.";
        history.push({ n: history.length + 1, action: "done (rejected)", outcome: check.why });
        opts.onStepEnd(n, `not accepted: ${check.why}`, false);
        return null;
      }
    } catch {
      // A validator that cannot be reached must not fail a good run.
    }

    opts.onStepEnd(n, "task complete", true);
    return finish("done", answer);
  };

  await writePlan(opts.startUrl ?? "");

  /** What the page looked like before the last action, to notice a no-op. */
  let lastPrint = "";
  let lastDid = "";

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

    // No-op detection. An action that left the URL, the scroll position and the
    // whole element list untouched did nothing, and the model has no way to
    // know that — it is shown a page, not a diff. Told plainly, it moves on;
    // left to infer it, it repeats the same click until the step cap.
    const print = fingerprint(page);
    // Never over the top of a correction the last step wrote: that one names a
    // specific element and is more use than this one's general observation.
    if (lastDid && print === lastPrint && !correction) {
      correction =
        `Your last action (${lastDid}) changed nothing: same URL, same scroll ` +
        "position, same elements. It did not work. Do something different.";
    }
    lastPrint = print;

    const injected = injectionSpans(page);

    // Decide, surviving a rate limit rather than dying on it. Free tiers are
    // tight enough that a 429 mid-run is routine, not exceptional.
    let proposal: Proposal | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts.signal.aborted) return finish("stopped");
      try {
        proposal = await propose({
          config: navigatorConfig,
          task: opts.task,
          page,
          history,
          notes,
          plan: plan.current?.steps,
          watchOut: plan.current?.watch_out,
          injected,
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
          const out = await concludeDone(bestAnswer || notes.join(" "), page, n);
          if (out) return out;
          continue;
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

    // The safety gate. Every action passes through here before anything else
    // looks at it, so no later branch can route around it.
    const verdict: Judgement = gate({ action, page, firewall, injected });
    if (verdict.severity === "refuse") {
      correction = `${verdict.what} was refused. ${verdict.because} Do something else.`;
      opts.onStepEnd(n, `refused: ${verdict.because}`, false);
      history.push(historyLine(history.length + 1, action, `refused: ${verdict.because}`));
      continue;
    }
    if (verdict.severity === "confirm") {
      const allowed = await approve({ what: verdict.what, because: verdict.because, url: page.url });
      if (!allowed) {
        correction =
          `The user did not approve: ${verdict.what}. Do not try it again. ` +
          "Finish with what you have, or tell them what is left to do.";
        opts.onStepEnd(n, `not approved: ${verdict.what}`, false);
        history.push(historyLine(history.length + 1, action, "user did not approve"));
        continue;
      }
      opts.onStepEnd(n, `approved: ${verdict.what}`, true);
    }

    // Ask before acting, so a wall the agent cannot pass is handed over rather
    // than hammered at until the step cap.
    const wall = opts.detectWall?.(page) ?? null;
    const signature =
      `${page.url}|${page.viewport.scrollY}|${action.action}` +
      `|${action.index ?? ""}|${action.value ?? ""}`;
    // Only actions that touch the page take part in loop detection. Repeating
    // `done` or `extract` is a different problem with its own handling below,
    // and counting it here hands the run over instead of answering it.
    const actuates = toCommand(action) !== null;
    if (actuates) {
      recent.push(signature);
      if (recent.length > 6) recent.shift();
    }
    const repeats = actuates ? recent.filter((r) => r === signature).length : 0;

    // Two identical choices means the element did nothing — a close button that
    // is not one, usually. Naming it and forbidding it recovers far more runs
    // than handing over does, so the nudge comes first and the handover only
    // if it does not take.
    if (repeats === 2 && !wall && nudgedFor !== signature) {
      nudgedFor = signature;
      correction =
        `${describeChoice(action)} did nothing — the page is unchanged. ` +
        "Do not choose it again. Pick a different element, or if the page is " +
        "already usable, get on with the task.";
      opts.onStepEnd(n, "no effect — trying something else", false);
      continue;
    }

    const stuck = repeats >= 3;

    // `stuck` can only be true for an action that touches the page, so the
    // exemptions here are about `wall`: asking is the right move on a sign-in
    // page, and an extraction is answered below rather than handed over.
    const handOff = (wall || stuck) && action.action !== "ask" && action.action !== "extract";

    // The last mechanical move before anything cleverer. A run that is stuck on
    // the same element is usually stuck behind an overlay, and Escape closes
    // most of them — including the ones whose close button carries no
    // accessible name, which is exactly the case no amount of prompting fixes
    // because the control is not in the index to be clicked.
    if (stuck && !wall && !escaped) {
      escaped = true;
      recent.length = 0;
      try {
        const result = await opts.execute({ kind: "key", name: "Escape" }, action);
        history.push({ n: history.length + 1, action: "press Escape", outcome: result.summary });
        opts.onStepEnd(n, "stuck — pressed Escape to close whatever is covering the page", true);
      } catch (err) {
        return finish("error", "", message(err));
      }
      correction =
        "Escape was pressed to close anything covering the page. Look at the " +
        "elements again — if the overlay is gone, get on with the task.";
      continue;
    }

    // A stuck run is exactly what a planner is for: the navigator has proved it
    // cannot see a way through from where it is standing. One re-plan, then the
    // human.
    if (stuck && !wall && opts.plan && !replanned) {
      replanned = true;
      recent.length = 0;
      await writePlan(page.url, `The agent repeated "${describeChoice(action)}" on ${page.url} and got nowhere.`);
      opts.onStepEnd(n, "stuck — replanned", true);
      continue;
    }

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
      const answer = action.value?.trim() || bestAnswer || notes.join(" ");
      if (action.action === "done" && answer) bestAnswer = answer;
      if (action.action === "fail") {
        opts.onStepEnd(n, `gave up: ${answer}`, false);
        return finish("failed", answer, undefined, "agent_gave_up");
      }
      const out = await concludeDone(answer, page, n);
      if (out) return out;
      continue;
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
      const key = squash(answer);
      if (notes.some((note) => squash(note).includes(key))) {
        if (extractRepeats >= 1) {
          const out = await concludeDone(bestAnswer || notes.join(" "), page, n);
          if (out) return out;
          continue;
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

      // A second look at the same thing usually adds to it rather than replacing
      // it — the title first, then the title with its price. Keeping both leaves
      // a stale half-fact in NOTES that ends up in the answer beside the whole
      // one, so the fuller version takes the older one's place.
      const refines = notes.findIndex((note) => {
        const old = squash(note);
        return key.startsWith(old) || (old.length >= 8 && key.includes(old));
      });
      if (refines >= 0) notes[refines] = answer;
      else notes.push(answer);
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
    lastDid = describeChoice(action).toLowerCase();
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

/**
 * What a page looks like, for telling "nothing happened" from "something did".
 *
 * Labels rather than a count: a search that replaces ten results with ten
 * different ones has the same length and a completely different page.
 */
function fingerprint(page: PageIndex): string {
  return [
    page.url,
    page.viewport.scrollY,
    page.elements.map((e) => `${e.role}:${e.label}`).join("|"),
  ].join("~");
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
