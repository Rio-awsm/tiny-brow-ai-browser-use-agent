export interface AgentSettings {
  /** Hard ceiling on steps in one run, so a confused agent stops rather than loops. */
  stepCap: number;
  /** Run to completion, versus proposing one step at a time for inspection. */
  autoRun: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  stepCap: 40,
  autoRun: true,
};

const KEY = "agent";

export async function loadAgentSettings(): Promise<AgentSettings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_AGENT_SETTINGS, ...(stored[KEY] as Partial<AgentSettings> | undefined) };
}

export async function saveAgentSettings(settings: AgentSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
