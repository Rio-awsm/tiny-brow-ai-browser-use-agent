import { DEFAULT_FIREWALL, type Firewall } from "./agent/safety";
import type { Routes } from "./agent/roles";

export interface AgentSettings {
  /** Hard ceiling on steps in one run, so a confused agent stops rather than loops. */
  stepCap: number;
  /** Run to completion, versus proposing one step at a time for inspection. */
  autoRun: boolean;
  /**
   * Check `done` with a second, independent call.
   *
   * On by default. A false completion costs the user more than the call costs
   * them, because it ends the run looking like a success.
   */
  validate: boolean;
  /**
   * Write a short plan before the first step, and again if the run gets stuck.
   *
   * On by default: it is two calls a run against a step cap of forty, and it is
   * the only thing that carries an ordering across a change of site.
   */
  plan: boolean;
  /** Per-role model overrides. Empty means every role uses the one provider. */
  routes: Routes;
  /** Where a run is allowed to go. Off unless the user turns it on. */
  firewall: Firewall;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  stepCap: 40,
  autoRun: true,
  validate: true,
  plan: true,
  routes: {},
  firewall: DEFAULT_FIREWALL,
};

const KEY = "agent";

export async function loadAgentSettings(): Promise<AgentSettings> {
  const stored = await chrome.storage.local.get(KEY);
  const saved = stored[KEY] as Partial<AgentSettings> | undefined;
  return {
    ...DEFAULT_AGENT_SETTINGS,
    ...saved,
    // Nested objects would otherwise be replaced wholesale by a partial saved
    // before these fields existed.
    routes: { ...DEFAULT_AGENT_SETTINGS.routes, ...saved?.routes },
    firewall: { ...DEFAULT_FIREWALL, ...saved?.firewall },
  };
}

export async function saveAgentSettings(settings: AgentSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
