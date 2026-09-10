import * as cdp from "./cdp";
import { PANEL_PORT } from "@/lib/messaging";
import { forgetActivity } from "./settle";

/**
 * Cancellation and session ownership for whatever is driving a tab.
 *
 * Cancellation has to be cooperative: the work is a promise chain inside the
 * service worker, so there is nothing to kill and each phase instead checks
 * whether it should stop. Every tab therefore always has a signal, whether the
 * action came from a run or from someone typing one command — otherwise Stop
 * would silently do nothing outside a run.
 *
 * A *session* is the separate concern: during a run the debugger stays attached
 * for the whole length of it, because attaching per action would mean an
 * attach/detach cycle and a banner flash on every step of a forty-step task.
 */

export class Aborted extends Error {
  constructor() {
    super("stopped");
    this.name = "Aborted";
  }
}

interface Entry {
  controller: AbortController;
  /** True while a run owns the debugger session for this tab. */
  session: boolean;
  /** Actions currently executing, so a stop can report whether it hit anything. */
  inFlight: number;
}

const entries = new Map<number, Entry>();

function entryFor(tabId: number): Entry {
  let entry = entries.get(tabId);
  if (!entry) {
    entry = { controller: new AbortController(), session: false, inFlight: 0 };
    entries.set(tabId, entry);
  }
  return entry;
}

export function signalFor(tabId: number): AbortSignal {
  return entryFor(tabId).controller.signal;
}

export function beginAction(tabId: number) {
  entryFor(tabId).inFlight++;
}

export function endAction(tabId: number) {
  const entry = entries.get(tabId);
  if (!entry) return;
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  // Nothing left to cancel and no run holding the tab: stop tracking it.
  if (entry.inFlight === 0 && !entry.session) entries.delete(tabId);
}

/** Halts whatever is running without giving up the session. */
export function abortRun(tabId: number): boolean {
  const entry = entries.get(tabId);
  if (!entry) return false;

  const hit = entry.inFlight > 0;
  entry.controller.abort();
  // Replaced at once, so the action after a stop is not born already aborted.
  entry.controller = new AbortController();
  return hit;
}

export function isSession(tabId: number): boolean {
  return entries.get(tabId)?.session ?? false;
}

export async function startRun(tabId: number, url: string): Promise<void> {
  await endRun(tabId);
  // Pinned, so the per-action handlers see an existing session and leave it
  // open rather than detaching underneath the run.
  await cdp.attach(tabId, url, true);
  entryFor(tabId).session = true;
}

/** Always safe to call, including when no run is active. */
export async function endRun(tabId: number): Promise<void> {
  const entry = entries.get(tabId);
  if (entry) {
    entry.controller.abort();
    entries.delete(tabId);
  }
  forgetActivity(tabId);
  await cdp.detach(tabId).catch(() => {});
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Aborted();
}

/**
 * The panel holds a port open for as long as it is on screen. Losing it means
 * nobody is left to end the run, so sessions are closed rather than left
 * holding the debugging banner over a page no one is driving.
 */
export function registerPanelLifecycle() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    port.onDisconnect.addListener(() => {
      for (const [tabId, entry] of [...entries]) {
        if (entry.session) void endRun(tabId);
        else entry.controller.abort();
      }
    });
  });
}
