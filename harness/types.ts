/**
 * Harness type contract.
 *
 * The one rule this file exists to enforce: a result is never a bare task score.
 * Every `AttemptResult` carries the backend it ran against, so the scoring
 * dimension can never be retrofitted later (M0 / M10).
 */

/** Difficulty tier, purely for reporting grouping. */
export type Tier = "trivial" | "easy" | "medium" | "hard" | "recovery";

/** How an attempt is judged. */
export type Scoring =
  /** The harness decides, by running `check` against the agent's answer. */
  | "auto"
  /** Depends on live account state or inventory; the operator resolves it. */
  | "manual";

export interface TaskDefinition {
  /** Stable id, e.g. "T01". Used as the primary key in every result file. */
  id: string;
  /** Short kebab-case name, e.g. "page-title". */
  slug: string;
  tier: Tier;
  scoring: Scoring;
  /** The exact string handed to the agent. Never paraphrased between runs. */
  prompt: string;
  /** Where the run starts. `null` means "wherever the tab already is". */
  startUrl: string | null;
  /**
   * Requires a signed-in browser profile. Unauthenticated runs are `skipped`,
   * not failed — a missing login is an operator problem, not an agent failure.
   */
  requiresAuth?: boolean;
  /**
   * Auto-scoring predicate. Receives the agent's final answer and the step log.
   * Absent for `scoring: "manual"` tasks.
   */
  check?: (outcome: AgentOutcome) => boolean;
}

/**
 * Why an attempt failed. Naming every failure is an M10 exit gate, so the
 * taxonomy is defined here rather than being invented ad hoc at reporting time.
 */
export type FailureMode =
  /** Model chose an element index that is not in the current index. */
  | "invalid_index"
  /** Same (url, action, target) hash three times — M12 loop breaking fired. */
  | "loop"
  /** Model said `done` but the goal was not met (caught by the M14 validator). */
  | "premature_done"
  /** Prompt exceeded the model's usable context. */
  | "context_overflow"
  /** Provider rejected `response_format.json_schema` outright. */
  | "schema_rejection"
  /** Model returned JSON that failed Zod validation. */
  | "schema_invalid"
  /** 429 from the provider, or the token budget ran out mid-run. */
  | "rate_limit"
  /**
   * `finish_reason: "length"` — on reasoning models the reasoning tokens are
   * generated before the content, so a tight max_tokens returns empty content
   * with no error. A budget bug that looks exactly like model failure.
   */
  | "truncated"
  /** Model acted coherently but chose the wrong thing. The interesting one. */
  | "wrong_reasoning"
  /** Hit the step cap without finishing. */
  | "step_cap"
  /** Exceeded the per-attempt wall-clock ceiling. Distinct from `step_cap`:
   *  the agent ran out of time, not out of steps, and the fixes differ. */
  | "timeout"
  /** Agent explicitly emitted `fail`. */
  | "agent_gave_up"
  /** Hit a sign-in or other wall only a human can pass. */
  | "needs_user"
  /** The endpoint was unreachable, refused, or 5xx'd. Not the model's fault. */
  | "provider_error"
  /** Page/DOM/CDP problem rather than a model problem. */
  | "page_error"
  /** The driver itself threw. A harness bug, never a model result. */
  | "driver_error"
  /** The driver is not built yet. Every attempt reports this until M9. */
  | "not_implemented"
  /** Anything unclassified. Should trend to zero. */
  | "unknown";

/** Identifies the backend under test. The third axis of every result. */
export interface BackendConfig {
  /**
   * Label only — a preset name or "custom". Nothing in the agent may branch
   * on this value; it exists so results can be grouped in a report.
   */
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * Non-portable provider parameters, passed through verbatim to the request
   * body (Groq's `reasoning_effort`, OpenRouter's `require_parameters`, ...).
   * The escape hatch that keeps vendor knowledge out of the shared interface.
   */
  extraParams?: Record<string, unknown>;
}

/** Token accounting. Prompt and completion are recorded separately, always. */
export interface TokenUsage {
  prompt: number;
  completion: number;
  /**
   * Prompt tokens the provider served from its prefix cache, where reported.
   * The observable payoff of the byte-identical system prompt (M8/M14).
   */
  cachedPrompt?: number;
}

/**
 * Wall clock, split. A single elapsed number cannot distinguish "waiting on a
 * slow local prefill" from "waiting on a hosted provider's quota", and those
 * two want opposite fixes.
 */
export interface Timing {
  /** Total attempt duration, start to finish. */
  totalMs: number;
  /** Summed time inside provider HTTP calls. */
  requestMs: number;
  /** Of `requestMs`, time spent blocked on rate-limit backoff. */
  rateLimitWaitMs: number;
  /** Of `requestMs`, prompt processing as the provider reported it. */
  prefillMs: number;
  /** Of `requestMs`, generation as the provider reported it. */
  generationMs: number;
  /** Time spent in the browser: CDP round trips, indexing, the waiting layer. */
  browserMs: number;
  /** Everything else — our own overhead. Derived, never measured directly. */
  harnessMs: number;
}

/** One step of the observe-decide-act cycle, as recorded for replay. */
export interface StepRecord {
  n: number;
  url: string;
  /** The action the model chose, serialised. */
  action: string;
  /** The model's stated reason. */
  reason: string;
  /** Element count in the index this step saw. */
  indexSize: number;
  usage: TokenUsage;
  requestMs: number;
  /** Prefill, where the provider reports it. Dominates on a local backend. */
  promptMs?: number;
  /** Generation, where the provider reports it. */
  completionMs?: number;
  /**
   * What the loop did with the choice, in its own words.
   *
   * Not the same thing as the action: a step where the loop refused, pushed
   * back, pressed Escape or replanned still records the model's proposal, and
   * without this line a log of nine identical clicks is indistinguishable from
   * a log of nine identical clicks with three recoveries in the middle.
   */
  outcome?: string;
  error?: string;
}

/** What the agent driver hands back at the end of a run. */
export interface AgentOutcome {
  /** The agent's final answer text, from its `done` action. Empty if it never finished. */
  answer: string;
  /** Structured payload from `done`, when the task asked for one. */
  data?: unknown;
  /** True only if the agent itself claimed completion. Says nothing about correctness. */
  completed: boolean;
  finalUrl: string;
  steps: StepRecord[];
  failure?: FailureMode;
  /** Provider or harness error text, surfaced verbatim. Never swallowed. */
  error?: string;
}

export type Verdict = "pass" | "fail" | "error" | "skipped" | "manual";

/** One attempt at one task on one backend. The atomic unit of the whole suite. */
export interface AttemptResult {
  taskId: string;
  taskSlug: string;
  tier: Tier;
  /** Denormalised on purpose — a result row must be readable without a join. */
  provider: string;
  model: string;
  baseUrl: string;
  attempt: number;
  verdict: Verdict;
  failure?: FailureMode;
  steps: number;
  usage: TokenUsage;
  timing: Timing;
  answer: string;
  error?: string;
  startedAt: string;
  stepLog: StepRecord[];
}

/** A full suite execution: every task, every attempt, one backend. */
export interface SuiteRun {
  startedAt: string;
  finishedAt: string;
  backend: Omit<BackendConfig, "apiKey">;
  attemptsPerTask: number;
  stepCap: number;
  results: AttemptResult[];
}

/** Options handed to a driver for a single attempt. */
export interface DriveOptions {
  task: TaskDefinition;
  backend: BackendConfig;
  stepCap: number;
  /** Aborts the attempt. The harness owns the timeout, not the driver. */
  signal: AbortSignal;
}

/**
 * The seam between the harness and the agent.
 *
 * M0 ships only `StubDriver`. From M9 the real loop implements this same
 * interface, so no scoring code changes when the agent arrives — and the
 * suite is runnable, and provably wired, before the agent exists.
 */
export interface AgentDriver {
  readonly name: string;
  /** Called once before the suite. Attach CDP, warm a connection, etc. */
  setup?(backend: BackendConfig): Promise<void>;
  drive(opts: DriveOptions): Promise<AgentOutcome>;
  /** Always called, even when the suite throws. Detach here. */
  teardown?(): Promise<void>;
}
