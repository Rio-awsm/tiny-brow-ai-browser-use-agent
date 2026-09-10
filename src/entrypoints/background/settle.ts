import { send } from "./cdp";
import { Aborted, throwIfAborted } from "./run";

/**
 * Waiting for the page to be worth reading.
 *
 * Most apparent reasoning failures are timing failures: the agent reads a
 * half-rendered SPA and then gets blamed for the conclusions it draws from it.
 * A fixed sleep is the wrong shape — too short on a slow page, wasted on a fast
 * one — so this waits on what actually indicates settling, in three layers:
 *
 *   1. main-frame loading stopped,
 *   2. no network requests in flight for a quiet period,
 *   3. the element count stops changing.
 *
 * Every layer has its own ceiling, because pages with polling widgets or
 * long-lived connections never truly go quiet and must not hang the run.
 */

interface TabActivity {
  inflight: Set<string>;
  loading: boolean;
  lastChange: number;
}

const activity = new Map<number, TabActivity>();

function track(tabId: number): TabActivity {
  let state = activity.get(tabId);
  if (!state) {
    state = { inflight: new Set(), loading: false, lastChange: Date.now() };
    activity.set(tabId, state);
  }
  return state;
}

export function registerSettleTracking() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;

    const state = track(tabId);
    const id = (params as { requestId?: string } | undefined)?.requestId;

    switch (method) {
      case "Network.requestWillBeSent":
        if (id) state.inflight.add(id);
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        if (id) state.inflight.delete(id);
        break;
      case "Page.frameStartedLoading":
        state.loading = true;
        break;
      case "Page.frameStoppedLoading":
        state.loading = false;
        break;
      default:
        return;
    }
    state.lastChange = Date.now();
  });

  chrome.tabs.onRemoved.addListener((tabId) => activity.delete(tabId));
}

export function forgetActivity(tabId: number) {
  activity.delete(tabId);
}

export interface SettleOptions {
  /** Stops the wait early; a stop must not be held up by a slow page. */
  signal?: AbortSignal;
  /** How long the network must stay quiet before it counts as settled. */
  quietMs?: number;
  /** How long the element count must hold steady. */
  stableMs?: number;
  /** Hard ceiling for the whole wait. */
  timeoutMs?: number;
}

export interface SettleResult {
  tookMs: number;
  /** Which layer ran out of time, if any. Worth reporting rather than hiding. */
  timedOut: "network" | "dom" | null;
}

export async function waitForSettle(
  tabId: number,
  opts: SettleOptions = {},
): Promise<SettleResult> {
  const quietMs = opts.quietMs ?? 400;
  const stableMs = opts.stableMs ?? 300;
  const timeoutMs = opts.timeoutMs ?? 6_000;

  const started = Date.now();
  const deadline = started + timeoutMs;

  const networkOk = await waitForQuiet(tabId, quietMs, deadline, opts.signal);
  const domOk = await waitForStableDom(tabId, stableMs, deadline, opts.signal);

  return {
    tookMs: Date.now() - started,
    timedOut: !networkOk ? "network" : !domOk ? "dom" : null,
  };
}

async function waitForQuiet(
  tabId: number,
  quietMs: number,
  deadline: number,
  signal?: AbortSignal,
) {
  const state = track(tabId);

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const quietFor = Date.now() - state.lastChange;
    if (!state.loading && state.inflight.size === 0 && quietFor >= quietMs) {
      return true;
    }
    await sleep(80);
  }
  return false;
}

/** Counting elements is cheap and catches the case where the DOM is still filling in. */
function countElements() {
  return { n: document.querySelectorAll("*").length, ready: document.readyState };
}

interface EvaluateResult {
  result: { value?: { n: number; ready: string } };
}

async function waitForStableDom(
  tabId: number,
  stableMs: number,
  deadline: number,
  signal?: AbortSignal,
) {
  let previous = -1;
  let steadySince = 0;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let current: number;
    try {
      const { result } = await send<EvaluateResult>(tabId, "Runtime.evaluate", {
        expression: `(${countElements.toString()})()`,
        returnByValue: true,
      });
      current = result.value?.n ?? -1;
    } catch (err) {
      // A stop must not be mistaken for a missing execution context.
      if (err instanceof Aborted) throw err;
      // Mid-navigation the context can be gone; that is not settled, but it is
      // also not a reason to fail the wait.
      previous = -1;
      await sleep(100);
      continue;
    }

    if (current === previous && current >= 0) {
      if (steadySince === 0) steadySince = Date.now();
      if (Date.now() - steadySince >= stableMs) return true;
    } else {
      steadySince = 0;
      previous = current;
    }
    await sleep(100);
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
