import { toWireSchema } from "./schema";
import {
  ProviderError,
  type CompleteOptions,
  type CompleteResult,
  type LLMProvider,
  type ProviderConfig,
  type RateLimit,
} from "./types";

/**
 * One implementation, every provider.
 *
 * Targets `POST /chat/completions` rather than a Responses API, because chat
 * completions is the universal surface: LM Studio, OpenRouter, LiteLLM and
 * Google's compatibility mode all implement it. Choosing it is what makes BYOK
 * real instead of aspirational.
 *
 * Uses structured output rather than tool calling. Models frequently fail to
 * emit tool calls through OpenAI-compatible layers because of chat-template
 * mismatches, and the failure is silent and total; schema-constrained decoding
 * sidesteps that whole class of bug.
 *
 * Written against `fetch` rather than a vendor SDK. The failure modes below —
 * content-type sniffing, rate-limit headers, distinguishing a truncated
 * response from an empty one — are the substance of this layer, and a client
 * that normalises them away would hide exactly what needs handling.
 */
export class OpenAICompatProvider implements LLMProvider {
  constructor(readonly config: ProviderConfig) {}

  async complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
    const { baseUrl, apiKey, model } = this.config;
    if (!baseUrl || !model) {
      throw new ProviderError("not_configured", "No endpoint or model configured yet.");
    }

    const body = {
      model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? this.config.maxTokens,
      temperature: opts.temperature ?? this.config.temperature,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: opts.schemaName,
          strict: true,
          schema: toWireSchema(opts.schema, opts.schemaName),
        },
      },
      ...this.config.extraParams,
    };

    const started = performance.now();
    let response: Response;

    try {
      response = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new ProviderError("aborted", "stopped");
      throw new ProviderError(
        "network",
        `Could not reach ${baseUrl}. Check the URL, and that the extension has permission for it.`,
        { detail: err instanceof Error ? err.message : String(err) },
      );
    }

    const requestMs = Math.round(performance.now() - started);
    const rateLimit = readRateLimit(response.headers);

    if (!response.ok) {
      throw await httpError(response, rateLimit);
    }

    // Content type first, not a parse exception. A wrong base URL commonly
    // answers 200 with an HTML login or landing page, and "Unexpected token <"
    // tells the user nothing about what is actually wrong.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      const preview = (await response.text()).slice(0, 200);
      throw new ProviderError(
        "not_json",
        `${baseUrl} answered with ${contentType || "no content type"} instead of JSON. That usually means the base URL is wrong.`,
        { detail: preview },
      );
    }

    const payload = (await response.json()) as ChatCompletion;
    const choice = payload.choices?.[0];
    const finishReason = choice?.finish_reason ?? "unknown";

    // On a reasoning model the reasoning is generated before the content, so a
    // tight max_tokens is consumed by it and the content comes back empty with
    // no error at all. Treating that as an empty answer would send the agent
    // chasing a model failure that is really a budget bug.
    if (finishReason === "length") {
      throw new ProviderError(
        "truncated",
        `The response hit the ${body.max_tokens}-token ceiling before finishing. Raise max tokens — on a reasoning model the reasoning is generated first and eats the budget.`,
        { detail: `finish_reason: length, completion tokens: ${payload.usage?.completion_tokens}` },
      );
    }

    const raw = choice?.message?.content ?? "";
    if (!raw.trim()) {
      throw new ProviderError(
        "invalid_json",
        "The model returned no content.",
        { detail: `finish_reason: ${finishReason}` },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderError(
        "invalid_json",
        "The model returned something that is not JSON, despite being asked for a schema.",
        { detail: raw.slice(0, 300) },
      );
    }

    const checked = opts.schema.safeParse(parsed);
    if (!checked.success) {
      throw new ProviderError(
        "schema_invalid",
        "The response was JSON but did not match the schema.",
        { detail: checked.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") },
      );
    }

    return {
      data: checked.data,
      usage: {
        prompt: payload.usage?.prompt_tokens ?? 0,
        completion: payload.usage?.completion_tokens ?? 0,
        cachedPrompt: payload.usage?.prompt_tokens_details?.cached_tokens,
      },
      rateLimit,
      requestMs,
      model: payload.model ?? model,
      finishReason,
      raw,
    };
  }
}

async function httpError(response: Response, rateLimit: RateLimit): Promise<ProviderError> {
  const text = await response.text().catch(() => "");
  const detail = extractMessage(text);
  const status = response.status;

  if (status === 401 || status === 403) {
    return new ProviderError("bad_key", "The endpoint rejected the API key.", { status, detail });
  }
  if (status === 429) {
    const wait = rateLimit.retryAfterMs ? ` Retry in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s.` : "";
    return new ProviderError("rate_limit", `Rate limited by the provider.${wait}`, {
      status,
      detail,
      rateLimit,
    });
  }
  // Surfaced verbatim rather than reworded: "does not support response format
  // json_schema" is the single most useful sentence a user can be shown, and it
  // is the provider's own.
  if (/json_schema|response_format|structured output/i.test(detail)) {
    return new ProviderError(
      "schema_rejected",
      "This model does not support schema-constrained output. Pick another model.",
      { status, detail },
    );
  }
  if (status === 404) {
    return new ProviderError("http", "No such endpoint or model at that URL.", { status, detail });
  }
  return new ProviderError("http", `The endpoint returned ${status}.`, { status, detail });
}

/** Pulls the human-readable message out of the many shapes providers use. */
function extractMessage(text: string): string {
  if (!text) return "";
  try {
    const json = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: string;
    };
    if (typeof json.error === "string") return json.error;
    return json.error?.message ?? json.message ?? json.detail ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function readRateLimit(headers: Headers): RateLimit {
  const num = (name: string) => {
    const value = headers.get(name);
    if (value === null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const retryAfter = num("retry-after");

  return {
    remainingTokens: num("x-ratelimit-remaining-tokens"),
    remainingRequests: num("x-ratelimit-remaining-requests"),
    resetTokens: headers.get("x-ratelimit-reset-tokens") ?? undefined,
    resetRequests: headers.get("x-ratelimit-reset-requests") ?? undefined,
    retryAfterMs: retryAfter === undefined ? undefined : retryAfter * 1000,
  };
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
