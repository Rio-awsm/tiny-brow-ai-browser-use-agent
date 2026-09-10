/**
 * The runner. Executes tasks x attempts against one backend and produces
 * `AttemptResult` rows.
 *
 * Two things live here on purpose:
 *  - the timeout, so a driver that hangs cannot hang the suite;
 *  - the verdict, so "did the agent succeed" is decided by the harness rather
 *    than by the agent's own claim of success. The agent saying `done` is an
 *    input to that decision, never the decision itself.
 */

import { judge } from "./tasks.js";
import type {
  AgentDriver,
  AttemptResult,
  BackendConfig,
  StepRecord,
  SuiteRun,
  TaskDefinition,
  Timing,
  TokenUsage,
  Verdict,
} from "./types.js";

export interface RunOptions {
  tasks: TaskDefinition[];
  backend: BackendConfig;
  driver: AgentDriver;
  attempts: number;
  stepCap: number;
  /** Per-attempt wall-clock ceiling. */
  timeoutMs: number;
  /** True when the browser profile is signed in; gates `requiresAuth` tasks. */
  authed: boolean;
  onAttempt?: (r: AttemptResult) => void;
}

function sumUsage(steps: StepRecord[]): TokenUsage {
  const total: TokenUsage = { prompt: 0, completion: 0, cachedPrompt: 0 };
  for (const s of steps) {
    total.prompt += s.usage.prompt;
    total.completion += s.usage.completion;
    total.cachedPrompt! += s.usage.cachedPrompt ?? 0;
  }
  if (total.cachedPrompt === 0) delete total.cachedPrompt;
  return total;
}

/**
 * Decides the verdict.
 *
 * `completed` is the agent's own claim and is deliberately not sufficient: a
 * confident wrong answer must score `fail`, which is the whole point of having
 * `check` predicates. From M14 the validator makes the same judgement inside
 * the loop, but the harness keeps its independent one either way.
 */
function verdictFor(
  task: TaskDefinition,
  outcome: Awaited<ReturnType<AgentDriver["drive"]>>,
  authed: boolean,
): Verdict {
  if (task.requiresAuth && !authed) return "skipped";
  // A driver-level error is distinct from the agent being wrong. Conflating
  // them makes a broken harness look like a weak model.
  if (
    outcome.failure === "not_implemented" ||
    outcome.failure === "page_error" ||
    outcome.failure === "driver_error"
  ) {
    return "error";
  }
  if (task.scoring === "manual") return "manual";
  if (!outcome.completed) return "fail";
  return judge(task, outcome) ? "pass" : "fail";
}

async function runAttempt(
  task: TaskDefinition,
  attempt: number,
  opts: RunOptions,
): Promise<AttemptResult> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);

  let outcome: Awaited<ReturnType<AgentDriver["drive"]>>;
  try {
    outcome = await opts.driver.drive({
      task,
      backend: opts.backend,
      stepCap: opts.stepCap,
      signal: ac.signal,
    });
  } catch (err) {
    outcome = {
      answer: "",
      completed: false,
      finalUrl: task.startUrl ?? "",
      steps: [],
      // A driver that throws is a harness fault, not the agent being wrong.
      // Labelling it "unknown" would quietly inflate the model's failure count.
      failure: ac.signal.aborted ? "timeout" : "driver_error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }

  const totalMs = performance.now() - t0;
  const requestMs = outcome.steps.reduce((n, s) => n + s.requestMs, 0);
  const prefillMs = outcome.steps.reduce((n, s) => n + (s.promptMs ?? 0), 0);
  const generationMs = outcome.steps.reduce((n, s) => n + (s.completionMs ?? 0), 0);

  // Anything not spent waiting on the provider was spent driving the browser:
  // CDP round trips, indexing, and the settle wait. Derived rather than
  // measured, because the browser side is not ours to instrument from here.
  const timing: Timing = {
    totalMs: round(totalMs),
    requestMs: round(requestMs),
    prefillMs: round(prefillMs),
    generationMs: round(generationMs),
    rateLimitWaitMs: 0,
    browserMs: round(Math.max(0, totalMs - requestMs)),
    harnessMs: round(Math.max(0, totalMs - requestMs)),
  };

  const verdict = verdictFor(task, outcome, opts.authed);

  return {
    taskId: task.id,
    taskSlug: task.slug,
    tier: task.tier,
    provider: opts.backend.provider,
    model: opts.backend.model,
    baseUrl: opts.backend.baseUrl,
    attempt,
    verdict,
    // Only label a failure mode on a run that actually failed — otherwise a
    // stale `failure` from a recovered step pollutes the M10 breakdown.
    failure: verdict === "pass" || verdict === "skipped" ? undefined : outcome.failure,
    steps: outcome.steps.length,
    usage: sumUsage(outcome.steps),
    timing,
    answer: outcome.answer,
    error: outcome.error,
    startedAt,
    stepLog: outcome.steps,
  };
}

export async function runSuite(opts: RunOptions): Promise<SuiteRun> {
  const startedAt = new Date().toISOString();
  const results: AttemptResult[] = [];

  await opts.driver.setup?.(opts.backend);
  try {
    for (const task of opts.tasks) {
      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        const r = await runAttempt(task, attempt, opts);
        results.push(r);
        opts.onAttempt?.(r);
      }
    }
  } finally {
    await opts.driver.teardown?.();
  }

  const { apiKey: _drop, ...backend } = opts.backend;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    backend,
    attemptsPerTask: opts.attempts,
    stepCap: opts.stepCap,
    results,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
