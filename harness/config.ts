/**
 * Backend configuration for the Node-side harness.
 *
 * SCOPE BOUNDARY — this module is the only place in the repo that reads `.env`,
 * and nothing under the extension's source tree may import it. Vite inlines
 * `import.meta.env` at build time, so a key reaching the extension bundle
 * through an env var would ship to every user who installs it. In the
 * extension, credentials come from the settings UI into `chrome.storage`.
 *
 * `npm run check:secrets` enforces that boundary mechanically.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig } from "./types.js";

let loaded = false;

/** Loads `.env` into `process.env` once. Node 20.12+ has this built in. */
export function loadEnv(root = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(root, ".env");
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

/**
 * A named backend preset. Purely data — the agent never branches on the name.
 * Adding a provider here must never require touching the provider code (M7).
 */
export interface Preset {
  name: string;
  baseUrl: string;
  /** Env var holding the key. */
  keyEnv: string;
  /**
   * Env var holding the endpoint, when it is not fixed. A preset's `baseUrl` is
   * only a default: LiteLLM is as often a hosted gateway as a local proxy, and
   * a self-hosted OpenAI-compatible endpoint lives wherever its owner put it.
   */
  baseUrlEnv?: string;
  /** Env var holding the model, when the preset suggests one. */
  modelEnv?: string;
  defaultModel?: string;
  extraParams?: Record<string, unknown>;
  /** Local endpoints authenticate nothing; demanding a key would block them. */
  needsKey?: boolean;
}

export const PRESETS: Record<string, Preset> = {
  groq: {
    needsKey: true,
    name: "groq",
    baseUrlEnv: "GROQ_BASE_URL",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    defaultModel: "openai/gpt-oss-20b",
    // Non-portable, and both are needed: hiding reasoning does not stop it
    // being generated and billed. Measured on "reply with one word",
    // include_reasoning alone was 51 completion tokens; adding
    // reasoning_effort:"low" brought it to 16.
    extraParams: { include_reasoning: false, reasoning_effort: "low" },
  },
  openrouter: {
    needsKey: true,
    name: "openrouter",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    // Route only to endpoints that actually honour response_format.
    extraParams: { require_parameters: true },
  },
  google: {
    needsKey: true,
    name: "google",
    baseUrlEnv: "GOOGLE_BASE_URL",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GOOGLE_API_KEY",
    modelEnv: "GOOGLE_MODEL",
    defaultModel: "gemini-2.5-flash",
  },
  litellm: {
    needsKey: false,
    name: "litellm",
    baseUrlEnv: "LITELLM_BASE_URL",
    baseUrl: "http://127.0.0.1:4000/v1",
    keyEnv: "LITELLM_API_KEY",
    modelEnv: "LITELLM_MODEL",
  },
  lmstudio: {
    needsKey: false,
    name: "lmstudio",
    baseUrlEnv: "LMSTUDIO_BASE_URL",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyEnv: "LMSTUDIO_API_KEY",
    modelEnv: "LMSTUDIO_MODEL",
  },
};

export interface ResolveOptions {
  /** Preset name, or "custom". Falls back to `LLM_PROVIDER`. */
  provider?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Resolves a backend.
 *
 * Precedence, and the ordering is load-bearing:
 *   1. an explicit CLI flag;
 *   2. the preset's own env vars and defaults;
 *   3. the generic `LLM_*` vars — but ONLY when the provider was not named
 *      explicitly on the command line.
 *
 * Rule 3 is the subtle one. `LLM_BASE_URL` in `.env` points at whatever backend
 * is currently being developed against. If it outranked a preset, then
 * `--provider lmstudio` would quietly keep talking to the hosted endpoint and
 * the matrix run in M10 would compare a backend against itself while reporting
 * two different names.
 */
export function resolveBackend(opts: ResolveOptions = {}): BackendConfig {
  loadEnv();

  // Naming a provider on the CLI is a deliberate override; falling back to
  // LLM_PROVIDER is not.
  const pinned = opts.provider !== undefined;
  const name = opts.provider ?? process.env.LLM_PROVIDER ?? "custom";
  const preset = PRESETS[name];

  const generic = <T>(v: T | undefined) => (pinned ? undefined : v);

  const baseUrl =
    opts.baseUrl ??
    (preset?.baseUrlEnv ? process.env[preset.baseUrlEnv] : undefined) ??
    generic(process.env.LLM_BASE_URL) ??
    preset?.baseUrl ??
    "";

  const model =
    opts.model ??
    (preset?.modelEnv ? process.env[preset.modelEnv] : undefined) ??
    generic(process.env.LLM_MODEL) ??
    preset?.defaultModel ??
    "";

  const apiKey =
    (preset?.keyEnv ? process.env[preset.keyEnv] : undefined) ??
    generic(process.env.LLM_API_KEY) ??
    "";

  return {
    provider: name,
    baseUrl,
    model,
    apiKey,
    extraParams: preset?.extraParams,
  };
}

export interface ConfigProblem {
  field: string;
  message: string;
}

/**
 * Reports what is missing rather than throwing. The harness must run with an
 * unconfigured backend — that is the M0 exit gate — so this is advisory until
 * a driver that actually needs credentials asks for them.
 */
export function validateBackend(b: BackendConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const preset = PRESETS[b.provider];
  if (!b.baseUrl) {
    problems.push({ field: "baseUrl", message: "no base URL — set LLM_BASE_URL or pass --base-url" });
  } else if (!/^https?:\/\//.test(b.baseUrl)) {
    problems.push({ field: "baseUrl", message: `not an http(s) URL: ${b.baseUrl}` });
  } else if (b.baseUrl.endsWith("/")) {
    problems.push({ field: "baseUrl", message: "trailing slash will produce a double slash in request paths" });
  } else if (/\/chat\/completions\/?$/.test(b.baseUrl)) {
    // Copied straight from a provider's docs, this reads correct and 404s: the
    // path is appended, so the request goes to /chat/completions/chat/completions.
    problems.push({
      field: "baseUrl",
      message: "drop the /chat/completions — it is appended for you",
    });
  }
  if (!b.model) {
    problems.push({ field: "model", message: "no model — set LLM_MODEL or pass --model" });
  }
  if (!b.apiKey && preset?.needsKey !== false) {
    problems.push({ field: "apiKey", message: "no API key found in the environment" });
  } else if (b.apiKey && /your_key_here/.test(b.apiKey)) {
    problems.push({ field: "apiKey", message: "key is still the .env.example placeholder" });
  }
  return problems;
}

/** Never log a key. Used in reports and console output. */
export function redact(b: BackendConfig): Omit<BackendConfig, "apiKey"> & { apiKey: string } {
  const k = b.apiKey;
  return {
    ...b,
    apiKey: k ? `${k.slice(0, 4)}…${k.slice(-2)} (${k.length} chars)` : "(unset)",
  };
}
