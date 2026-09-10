import type { z } from "zod";

export interface ProviderConfig {
  /** Preset id, or "custom". A label only — no code may branch on it. */
  preset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Non-portable provider parameters, merged verbatim into the request body.
   * Groq's `reasoning_effort`, OpenRouter's `require_parameters`, and whatever
   * the next provider invents. The moment one of these becomes a first-class
   * field, the core layer has learned about a vendor.
   */
  extraParams: Record<string, unknown>;
  /**
   * Generous on purpose. On a reasoning model the reasoning tokens are emitted
   * before the content, so a tight budget is eaten by them and the response
   * comes back empty with finish_reason "length" — which looks exactly like the
   * model failing and is really a budget bug.
   */
  maxTokens: number;
  temperature: number;
}

export type ProviderErrorKind =
  | "not_configured"
  /** Base URL unreachable, DNS failure, CORS, no host permission. */
  | "network"
  /** Endpoint answered, but not with JSON — usually a wrong base URL. */
  | "not_json"
  | "bad_key"
  | "rate_limit"
  /** The model or endpoint rejected `response_format.json_schema`. */
  | "schema_rejected"
  /** `finish_reason: "length"` — a hard error, never an empty answer. */
  | "truncated"
  /** Content was not parseable JSON. */
  | "invalid_json"
  /** Parsed, but failed Zod validation. */
  | "schema_invalid"
  | "http"
  | "aborted";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** The provider's own error text, never swallowed. */
  readonly detail?: string;
  readonly rateLimit?: RateLimit;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: { status?: number; detail?: string; rateLimit?: RateLimit } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.detail = opts.detail;
    this.rateLimit = opts.rateLimit;
  }
}

export interface RateLimit {
  remainingTokens?: number;
  remainingRequests?: number;
  resetTokens?: string;
  resetRequests?: string;
  retryAfterMs?: number;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  cachedPrompt?: number;
}

/**
 * Server-side timing, where the provider reports it.
 *
 * A single elapsed number cannot separate prefill from generation, and those
 * two want opposite fixes: prefill is cut by a smaller prompt, generation by a
 * smaller answer or a faster model. Groq reports all three; most providers
 * report none, and the fields are simply absent rather than guessed at.
 */
export interface ServerTimings {
  queueMs?: number;
  /** Prompt processing — prefill. Dominates on a local backend. */
  promptMs?: number;
  /** Token generation. */
  completionMs?: number;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions<T> {
  messages: Message[];
  /** Defined once; both the wire schema and the runtime check derive from it. */
  schema: z.ZodType<T>;
  /** Names the schema on the wire. Appears in provider error messages. */
  schemaName: string;
  signal?: AbortSignal;
  /** Overrides for this call only. */
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResult<T> {
  data: T;
  usage: TokenUsage;
  /** What the provider said it spent, as opposed to what we measured. */
  timings: ServerTimings;
  rateLimit: RateLimit;
  requestMs: number;
  model: string;
  finishReason: string;
  /** The raw content string, for logging a failure without re-requesting. */
  raw: string;
}

export interface LLMProvider {
  readonly config: ProviderConfig;
  complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>>;
}
