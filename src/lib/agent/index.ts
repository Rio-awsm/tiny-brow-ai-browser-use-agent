import type { Command } from "@/lib/commands";
import type { PageIndex } from "@/lib/page-index";
import {
  makeProvider,
  type ProviderConfig,
  type ServerTimings,
  type TokenUsage,
} from "@/lib/provider";
import { buildMessages, type HistoryEntry } from "./prompt";
import { ActionSchema, validateAction, type AgentAction } from "./schema";

export * from "./schema";
export { SYSTEM_PROMPT, buildMessages, historyLine, type HistoryEntry } from "./prompt";

/** Hosts and paths that exist to authenticate a human, not an agent. */
const AUTH_HOST = /(^|\.)accounts\.google\.com$|(^|\.)login\.|(^|\.)signin\.|(^|\.)auth\./i;
const AUTH_PATH = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|oauth|sso|challenge|verify)(\/|$|\?)/i;

/**
 * Recognises a page that is asking a human to prove who they are.
 *
 * Detected in code rather than left to the model, because this is exactly the
 * wall it will otherwise batter itself against: no listed element makes
 * progress, so every step looks locally reasonable and the run loops until the
 * cap. Tiny cannot and must not sign in — the user does that.
 */
export function detectAuthWall(page: PageIndex): string | null {
  let host = "";
  let path = "";
  try {
    const url = new URL(page.url);
    host = url.host;
    path = url.pathname;
  } catch {
    /* a page with no parseable URL is not an auth wall */
  }

  const secretField = page.elements.find((e) =>
    /password|passcode|one[- ]?time|otp/i.test(`${e.role} ${e.note} ${e.label}`),
  );

  if (secretField) return "This page is asking for a password or a one-time code.";
  if (host && AUTH_HOST.test(host)) return `${host} is a sign-in page.`;
  if (path && AUTH_PATH.test(path)) return "This page is a sign-in or registration flow.";
  return null;
}

/**
 * Stands in for a page Chrome will not let us inspect.
 *
 * Chrome blocks CDP on its own pages, so a new-tab page cannot be indexed —
 * but `navigate` needs no debugger session, so it is still a page the agent can
 * act from. Failing the task here instead would make a fresh window a dead end
 * the agent could never start from.
 */
export function unreadablePage(url: string, title: string, reason: string): PageIndex {
  return {
    url,
    title,
    elements: [],
    totalFound: 0,
    viewport: { w: 0, h: 0, scrollX: 0, scrollY: 0, docH: 0 },
    text: `This page cannot be inspected or clicked. ${reason} The only useful action here is navigate.`,
    textChars: 0,
    tookMs: 0,
  };
}

export interface Proposal {
  action: AgentAction;
  /** Set when the action is well-formed but unusable, e.g. an index that is not listed. */
  problem: string | null;
  usage: TokenUsage;
  requestMs: number;
  /** Prefill and generation split, where the provider reports it. */
  timings: ServerTimings;
  model: string;
  /** Prompt tokens the provider served from its cache, where reported. */
  cached: number;
  promptChars: number;
}

export interface ProposeInput {
  config: ProviderConfig;
  task: string;
  page: PageIndex;
  history: HistoryEntry[];
  correction?: string;
  signal?: AbortSignal;
}

export async function propose(input: ProposeInput): Promise<Proposal> {
  const messages = buildMessages({
    task: input.task,
    history: input.history,
    page: input.page,
    correction: input.correction,
  });

  const result = await makeProvider(input.config).complete({
    messages,
    schema: ActionSchema,
    schemaName: "agent_action",
    signal: input.signal,
  });

  return {
    action: result.data,
    // Decoding guarantees the shape; whether the chosen index exists is ours to check.
    problem: validateAction(result.data, input.page.elements)?.message ?? null,
    usage: result.usage,
    requestMs: result.requestMs,
    timings: result.timings,
    model: result.model,
    cached: result.usage.cachedPrompt ?? 0,
    promptChars: messages.reduce((n, m) => n + m.content.length, 0),
  };
}

/**
 * Maps a proposed action onto the actuation layer built in M5.
 *
 * `extract`, `done` and `fail` produce nothing to execute — they are answers,
 * not page interactions.
 */
export function toCommand(action: AgentAction): Command | null {
  switch (action.action) {
    case "click":
      return { kind: "click", index: action.index! };
    case "type":
      return { kind: "type", index: action.index!, text: action.value!, mode: "keys" };
    case "scroll":
      return { kind: "scroll", direction: action.direction ?? "down", amount: 600 };
    case "navigate":
      return { kind: "goto", url: action.value! };
    default:
      return null;
  }
}
