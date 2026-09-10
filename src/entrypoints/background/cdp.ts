import {
  restrictionFor,
  type CdpStatus,
  type Screenshot,
} from "@/lib/cdp-types";

const PROTOCOL_VERSION = "1.3";
const STORE_KEY = "cdp:sessions";

interface Session {
  tabId: number;
  /** Explicit attach from the panel; one-shot captures detach themselves. */
  pinned: boolean;
  attachedAt: number;
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

/**
 * Session bookkeeping survives service-worker eviction.
 *
 * MV3 tears the worker down after ~30s idle, taking any module-level Map with
 * it — while Chrome's actual debugger session, and its banner, stay up. State
 * held only in memory therefore reports "detached" on a tab that is still
 * attached, and the Detach button never appears to fix it.
 *
 * `chrome.storage.session` lives in memory for the browser session but outlives
 * the worker, so it is the record. `chrome.debugger.getTargets()` is the
 * authority on what is genuinely attached; the record only says whether a live
 * session is ours.
 */
async function load(): Promise<Map<number, Session>> {
  const stored = await chrome.storage.session.get(STORE_KEY);
  const list = (stored[STORE_KEY] ?? []) as Session[];
  return new Map(list.map((s) => [s.tabId, s]));
}

async function save(sessions: Map<number, Session>): Promise<void> {
  await chrome.storage.session.set({ [STORE_KEY]: [...sessions.values()] });
}

async function forget(tabId: number): Promise<void> {
  const sessions = await load();
  if (sessions.delete(tabId)) await save(sessions);
}

async function remember(session: Session): Promise<void> {
  const sessions = await load();
  sessions.set(session.tabId, session);
  await save(sessions);
}

/** Chrome's own view: is any debugger attached to this tab? */
async function chromeSaysAttached(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached);
}

/** Set when Chrome tears a session down under us, so the panel can say why. */
const detachReasons = new Map<number, string>();

export function registerCdpLifecycle() {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    void forget(source.tabId);
    detachReasons.set(
      source.tabId,
      reason === "canceled_by_user"
        ? "DevTools opened on this tab and took over the debugger."
        : `Chrome ended the session (${reason}).`,
    );
    console.log("[tiny-brow cdp] detached", source.tabId, reason);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void forget(tabId);
    detachReasons.delete(tabId);
  });

  chrome.runtime.onSuspend.addListener(() => {
    // Best effort: onSuspend gives no time for async work, so this is a
    // courtesy. Correctness comes from reconciling against getTargets().
    void load().then((sessions) => {
      for (const tabId of sessions.keys()) {
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
    });
  });
}

export async function status(tabId: number | null, url: string): Promise<CdpStatus> {
  if (tabId === null) {
    return { state: "detached", tabId: null, url, pinned: false, owned: false };
  }

  const [sessions, live] = await Promise.all([load(), chromeSaysAttached(tabId)]);
  const session = sessions.get(tabId);

  if (live) {
    return {
      state: "attached",
      tabId,
      url,
      pinned: session?.pinned ?? false,
      owned: session !== undefined,
      attachedAt: session?.attachedAt,
      reason: session
        ? undefined
        : "A debugger is attached to this tab, but not by Tiny. Detach will try to release it; if it is DevTools, close DevTools instead.",
    };
  }

  // Chrome says nothing is attached, so a leftover record is stale.
  if (session) await forget(tabId);

  const restriction = restrictionFor(url);
  if (restriction) {
    return { state: "restricted", tabId, url, reason: restriction, pinned: false, owned: false };
  }

  return {
    state: "detached",
    tabId,
    url,
    pinned: false,
    owned: false,
    reason: detachReasons.get(tabId),
  };
}

export async function attach(tabId: number, url: string, pinned: boolean) {
  const restriction = restrictionFor(url);
  if (restriction) throw new CdpError(restriction);

  if (await chromeSaysAttached(tabId)) {
    const sessions = await load();
    const session = sessions.get(tabId);
    if (!session) {
      throw new CdpError(
        "This tab already has a debugger attached by something else — close DevTools, or use Detach to try to release it.",
      );
    }
    if (pinned && !session.pinned) {
      session.pinned = true;
      await save(sessions);
    }
    return;
  }

  detachReasons.delete(tabId);

  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (err) {
    throw new CdpError(explainAttachFailure(err));
  }

  await remember({ tabId, pinned, attachedAt: Date.now() });

  try {
    await send(tabId, "Page.enable");
    await send(tabId, "Runtime.enable");
  } catch (err) {
    await detach(tabId);
    throw new CdpError(`Attached but could not enable domains: ${message(err)}`);
  }

  console.log("[tiny-brow cdp] attached", tabId, { pinned });
}

/**
 * Detaches, then verifies against Chrome. A silent failure here is what leaves
 * the debugging banner up while the panel claims to be detached, so a refusal
 * is raised rather than logged.
 */
export async function detach(tabId: number) {
  let failure: string | null = null;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    failure = message(err);
  }

  if (await chromeSaysAttached(tabId)) {
    throw new CdpError(
      /devtools/i.test(failure ?? "") || failure === null
        ? "Chrome still reports a debugger on this tab. If DevTools is open on it, close DevTools — only one debugger may attach per tab."
        : `Chrome refused to detach: ${failure}`,
    );
  }

  await forget(tabId);
  detachReasons.delete(tabId);
  console.log("[tiny-brow cdp] detach ok", tabId);
}

/**
 * CDP commands are given a deadline because they do not always come back. A
 * page that navigates while a command is in flight can leave the promise
 * pending forever, which strands the message handler that awaited it — and a
 * handler that never settles surfaces in the panel as "background did not
 * reply", with nothing in the log to say why.
 */
const COMMAND_TIMEOUT_MS = 10_000;

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CdpError(
            `${method} did not return within ${COMMAND_TIMEOUT_MS / 1000}s — the page may have navigated mid-command.`,
          ),
        ),
      COMMAND_TIMEOUT_MS,
    );
  });

  try {
    return (await Promise.race([
      chrome.debugger.sendCommand({ tabId }, method, params),
      deadline,
    ])) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface LayoutMetrics {
  cssVisualViewport?: { clientWidth: number; clientHeight: number };
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
}

export async function screenshot(tabId: number, url: string): Promise<Screenshot> {
  const started = performance.now();
  const alreadyOpen = await chromeSaysAttached(tabId);

  await attach(tabId, url, false);

  try {
    const metrics = await send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;

    const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 72,
      captureBeyondViewport: false,
    });

    return {
      dataUrl: `data:image/jpeg;base64,${data}`,
      width: Math.round(viewport?.clientWidth ?? 0),
      height: Math.round(viewport?.clientHeight ?? 0),
      bytes: Math.round((data.length * 3) / 4),
      capturedAt: Date.now(),
      tookMs: Math.round(performance.now() - started),
    };
  } finally {
    // A capture that opened its own session closes it again, so a one-shot
    // never leaves the debugging banner up.
    if (!alreadyOpen) {
      const sessions = await load();
      if (!sessions.get(tabId)?.pinned) {
        await detach(tabId).catch((err) =>
          console.warn("[tiny-brow cdp] cleanup detach failed", message(err)),
        );
      }
    }
  }
}

/** Turns Chrome's generic attach errors into something actionable. */
function explainAttachFailure(err: unknown): string {
  const text = message(err);
  if (/another debugger|already attached/i.test(text)) {
    return "Another debugger is already attached to this tab — close DevTools (or the other extension) and try again.";
  }
  if (/cannot access|cannot attach/i.test(text)) {
    return "Chrome refused to attach to this page. Chrome's own pages and the Web Store are off limits.";
  }
  if (/no tab with id/i.test(text)) {
    return "That tab no longer exists.";
  }
  return text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
