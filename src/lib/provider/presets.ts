/**
 * The preset table. Purely data.
 *
 * This file is the only place in the codebase a provider is named. Adding one
 * must never require touching the provider implementation — if it does, the
 * BYOK promise is a marketing claim rather than an architecture.
 *
 * "Custom" is not an afterthought. It is the option that keeps the rest honest,
 * because it is the only one that proves nothing provider-specific leaked into
 * the code path.
 */

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  /** Suggestions only. The field stays free text. */
  models: string[];
  /** Defaults for the passthrough bag; the user can edit or clear them. */
  extraParams?: Record<string, unknown>;
  /** Local endpoints do not need a real key. */
  needsKey: boolean;
  local?: boolean;
  keyHint?: string;
  note?: string;
  docsUrl?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
    // Both are needed together: hiding reasoning does not stop it being
    // generated and billed.
    extraParams: { include_reasoning: false, reasoning_effort: "low" },
    needsKey: true,
    keyHint: "gsk_…",
    note: "Free tier is 8,000 tokens/min, which bounds the agent to a few steps per minute.",
    docsUrl: "https://console.groq.com/docs",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["google/gemini-2.5-flash", "qwen/qwen3-30b-a3b", "openai/gpt-oss-120b"],
    // Routes only to endpoints that actually honour response_format.
    extraParams: { require_parameters: true },
    needsKey: true,
    keyHint: "sk-or-v1-…",
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "google",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    needsKey: true,
    keyHint: "AIza…",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
  },
  {
    id: "litellm",
    label: "LiteLLM proxy",
    baseUrl: "http://127.0.0.1:4000/v1",
    models: [],
    needsKey: false,
    local: true,
    note: "Proxies many providers behind one OpenAI-compatible URL.",
    docsUrl: "https://docs.litellm.ai",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [],
    needsKey: false,
    local: true,
    note: "Enable CORS in LM Studio's server settings, set context length explicitly, and use one parallel slot.",
    docsUrl: "https://lmstudio.ai/docs/developer",
  },
  {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "",
    models: [],
    needsKey: false,
    note: "Anything speaking POST /chat/completions.",
  },
];

export const DEFAULT_PRESET = "custom";

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
