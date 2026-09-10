import type { ProviderConfig } from "@/lib/provider";

/**
 * Client for the scoring harness's local bridge.
 *
 * The harness cannot import the agent — it lives in an extension — so it hands
 * out one task at a time over HTTP and the panel runs it here, against the real
 * browser, with the real loop. That is the only way the scores describe the
 * thing that actually ships.
 */

export const DEFAULT_BRIDGE = "http://127.0.0.1:8787";

export interface BenchTask {
  id: string;
  task: string;
  startUrl: string | null;
  stepCap: number;
  /** The backend the harness is scoring, which overrides the saved settings. */
  backend: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    extraParams?: Record<string, unknown>;
  };
}

export interface BenchStep {
  n: number;
  url: string;
  action: string;
  reason: string;
  indexSize: number;
  usage: { prompt: number; completion: number; cachedPrompt?: number };
  requestMs: number;
  /** Prefill and generation, where the provider reported them. */
  promptMs?: number;
  completionMs?: number;
  /** What the loop did with the choice — refused, pushed back, recovered. */
  outcome?: string;
  error?: string;
}

export interface BenchOutcome {
  answer: string;
  data?: unknown;
  completed: boolean;
  finalUrl: string;
  steps: BenchStep[];
  failure?: string;
  error?: string;
}

export async function bridgeHealthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${trim(base)}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns null when the harness has nothing queued. */
export async function nextTask(base: string): Promise<BenchTask | null> {
  const res = await fetch(`${trim(base)}/task`, { cache: "no-store" });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`bridge returned ${res.status}`);
  return (await res.json()) as BenchTask;
}

export async function postResult(
  base: string,
  id: string,
  outcome: BenchOutcome,
): Promise<void> {
  await fetch(`${trim(base)}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, outcome }),
  });
}

/**
 * The harness owns which backend is under test, so its config wins for the
 * duration of a task. Everything the harness does not send falls back to the
 * saved settings, so max tokens and temperature stay whatever the user chose.
 */
export function backendToConfig(
  task: BenchTask,
  saved: ProviderConfig,
): ProviderConfig {
  return {
    ...saved,
    preset: task.backend.provider,
    baseUrl: task.backend.baseUrl,
    apiKey: task.backend.apiKey,
    model: task.backend.model,
    extraParams: task.backend.extraParams ?? {},
  };
}

const trim = (url: string) => url.replace(/\/+$/, "");
