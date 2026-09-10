import { OpenAICompatProvider } from "./openai-compat";
import { DEFAULT_PRESET, presetById } from "./presets";
import { ProbeSchema } from "./schema";
import { ProviderError, type ProviderConfig } from "./types";

export * from "./types";
export * from "./presets";
export { toWireSchema, strictModeProblems, ProbeSchema } from "./schema";
export { OpenAICompatProvider } from "./openai-compat";

const STORAGE_KEY = "provider";

export const DEFAULT_CONFIG: ProviderConfig = {
  preset: DEFAULT_PRESET,
  baseUrl: "",
  apiKey: "",
  model: "",
  extraParams: {},
  maxTokens: 1024,
  temperature: 0,
};

/**
 * Credentials live here and nowhere else.
 *
 * Never an env var. Vite inlines build-time environment values into the output,
 * so a key read that way would be baked into the published bundle and shipped to
 * every user who installs the extension. `npm run check:secrets` enforces that,
 * and it is a plain text scan — which is why this comment does not spell the
 * banned expression out.
 */
export async function loadConfig(): Promise<ProviderConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_CONFIG, ...(stored[STORAGE_KEY] as Partial<ProviderConfig> | undefined) };
}

export async function saveConfig(config: ProviderConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

export function makeProvider(config: ProviderConfig) {
  return new OpenAICompatProvider(config);
}

export interface ConfigProblem {
  field: "baseUrl" | "apiKey" | "model" | "extraParams";
  message: string;
}

export function validateConfig(config: ProviderConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const preset = presetById(config.preset);

  if (!config.baseUrl) {
    problems.push({ field: "baseUrl", message: "Needed — where should requests go?" });
  } else if (!/^https?:\/\//i.test(config.baseUrl)) {
    problems.push({ field: "baseUrl", message: "Must start with http:// or https://" });
  } else if (/\/chat\/completions\/?$/.test(config.baseUrl)) {
    problems.push({
      field: "baseUrl",
      message: "Leave off /chat/completions — that is appended for you.",
    });
  }

  if (!config.model) {
    problems.push({ field: "model", message: "Needed — which model should answer?" });
  }

  if (preset?.needsKey && !config.apiKey) {
    problems.push({ field: "apiKey", message: "This provider needs a key." });
  }

  return problems;
}

/** The origin pattern the extension needs permission for, to reach this endpoint. */
export function originPattern(baseUrl: string): string | null {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    return null;
  }
}

export async function hasHostPermission(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin] });
}

/**
 * Asked for at the moment an endpoint is saved, rather than declared up front.
 *
 * A BYOK tool cannot know its endpoints in advance, so the alternative is
 * requesting broad host access at install time. Narrowing it to the one origin
 * the user actually typed is more work and far easier to defend.
 * Must be called from a user gesture.
 */
export async function requestHostPermission(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  if (!origin) return false;
  return chrome.permissions.request({ origins: [origin] });
}

export interface ProbeResult {
  ok: boolean;
  headline: string;
  detail?: string;
  requestMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  remainingTokens?: number;
}

/**
 * One tiny schema-constrained request, reported exactly as it came back.
 *
 * This exists to turn "why does it do nothing" into a self-service answer: it
 * distinguishes a bad URL from a bad key from a model that rejects schemas,
 * which are otherwise indistinguishable from the outside.
 */
export async function testConnection(config: ProviderConfig): Promise<ProbeResult> {
  const problems = validateConfig(config);
  if (problems.length) {
    return { ok: false, headline: "Not configured yet", detail: problems[0]!.message };
  }

  if (!(await hasHostPermission(config.baseUrl))) {
    return {
      ok: false,
      headline: "No permission for that origin",
      detail: "Save the settings first — that is when permission is requested.",
    };
  }

  try {
    const result = await makeProvider(config).complete({
      schema: ProbeSchema,
      schemaName: "connection_probe",
      maxTokens: Math.max(config.maxTokens, 512),
      messages: [
        { role: "system", content: "Reply only with the requested JSON." },
        { role: "user", content: 'Set ok to true and word to "tiny".' },
      ],
    });

    return {
      ok: true,
      headline: "Connected",
      detail: `Schema honoured, returned "${result.data.word}".`,
      requestMs: result.requestMs,
      promptTokens: result.usage.prompt,
      completionTokens: result.usage.completion,
      model: result.model,
      remainingTokens: result.rateLimit.remainingTokens,
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return { ok: false, headline: err.message, detail: err.detail };
    }
    return {
      ok: false,
      headline: "Unexpected failure",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
