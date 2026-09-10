import { create } from "zustand";
import type { TabInfo } from "./messaging";

export type LogLevel = "info" | "sent" | "recv" | "error";

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  text: string;
}

interface PanelState {
  task: string;
  running: boolean;
  tab: TabInfo | null;
  log: LogEntry[];
  setTask: (task: string) => void;
  setRunning: (running: boolean) => void;
  setTab: (tab: TabInfo | null) => void;
  append: (level: LogLevel, text: string) => void;
  clearLog: () => void;
}

let nextId = 1;

export const usePanel = create<PanelState>((set) => ({
  task: "",
  running: false,
  tab: null,
  log: [],
  setTask: (task) => set({ task }),
  setRunning: (running) => set({ running }),
  setTab: (tab) => set({ tab }),
  append: (level, text) =>
    set((s) => ({
      log: [...s.log, { id: nextId++, at: Date.now(), level, text }],
    })),
  clearLog: () => set({ log: [] }),
}));
