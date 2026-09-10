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
// Word boundaries matter on the short ones: "otp" sits inside "adoption" and
// "pin" inside "shipping", either of which would refuse an ordinary field.
const SECRET_FIELD = /password|passcode|one[- ]?time|\botp\b|\bcvv\b/i;
const DISMISS = /\bclose\b|dismiss|not now|no thanks|maybe later|\bskip\b|continue without/i;

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

  // Only the URL decides. A page that exists to sign you in has nothing else on
  // it to do, so stopping is right.
  if (host && AUTH_HOST.test(host)) return `${host} is a sign-in page.`;
  if (path && AUTH_PATH.test(path)) return "This page is a sign-in or registration flow.";

  // A password field on an ordinary URL is an overlay, not a wall. Trying to
  // tell "dismissible" from "not" by looking for a close control does not work:
  // plenty of sites give theirs no accessible name at all, and guessing wrong
  // hands over a task the agent could have finished. Let it try — filling the
  // field is refused in `validateAction` regardless, and if it genuinely cannot
  // get past the overlay the loop detector hands over a few steps later.
  return null;
}

/** Index of a plausible way out of an overlay, or null if there is none. */
export function findDismissControl(page: PageIndex): number | null {
  const match = page.elements.find((e) => DISMISS.test(`${e.label} ${e.note}`));
  return match ? match.i : null;
}

/**
 * The one thing about this page that has to be dealt with before the task.
 *
 * A popup thrown over a site on arrival is the common case, and from the index
 * alone it is not obvious: the model sees a handful of elements that have
 * nothing to do with its task and starts guessing at them. Saying that a dialog
 * is open, and which element closes it, turns several wasted steps into one.
 */
export function pageNotice(page: PageIndex): string | null {
  const wall = detectAuthWall(page);
  if (wall) return `${wall} You cannot sign in — use ask.`;

  const dismiss = findDismissControl(page);
  const closes =
    dismiss === null
      ? "Find its close button and click it."
      : `[${dismiss}] closes it.`;

  // A sign-in prompt on an ordinary page is something to get past, not a
  // reason to stop — and it is worth saying so, because the elements on show
  // have nothing to do with the task and invite guessing.
  const signIn = page.elements.some((e) =>
    SECRET_FIELD.test(`${e.role} ${e.note} ${e.label}`),
  );
  if (signIn) {
    return `A sign-in prompt is covering the page. You cannot sign in, so do not fill it in — dismiss it and carry on with the task. ${closes}`;
  }

  const dialog = page.elements.some((e) => e.note.includes("in dialog"));
  if (!dialog) return null;

  return `A dialog is covering the page and everything behind it is hidden. ${closes} Do that first unless the dialog is what you need.`;
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
  notes?: string[];
  correction?: string;
  signal?: AbortSignal;
}

export async function propose(input: ProposeInput): Promise<Proposal> {
  const messages = buildMessages({
    task: input.task,
    history: input.history,
    notes: input.notes,
    page: input.page,
    correction: input.correction,
    notice: pageNotice(input.page),
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
