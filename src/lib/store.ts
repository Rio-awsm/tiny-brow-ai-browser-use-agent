import { create } from "zustand";
import type { CdpStatus, Screenshot } from "./cdp-types";
import type { TabInfo } from "./messaging";
import type { PageIndex } from "./page-index";

export type NoteLevel = "info" | "sent" | "recv" | "error";

interface Base {
  id: number;
  at: number;
}

export type PanelEvent =
  | (Base & { kind: "note"; level: NoteLevel; text: string })
  | (Base & { kind: "task"; text: string })
  | (Base & { kind: "shot"; shot: Screenshot })
  | (Base & { kind: "index"; index: PageIndex });

/** Omit over a union must distribute, or the branches collapse to their overlap. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewPanelEvent = DistributiveOmit<PanelEvent, "id" | "at">;

interface PanelState {
  task: string;
  running: boolean;
  tab: TabInfo | null;
  cdp: CdpStatus | null;
  events: PanelEvent[];
  setTask: (task: string) => void;
  setRunning: (running: boolean) => void;
  setTab: (tab: TabInfo | null) => void;
  setCdp: (cdp: CdpStatus | null) => void;
  note: (level: NoteLevel, text: string) => void;
  push: (event: NewPanelEvent) => void;
  clear: () => void;
}

let nextId = 1;
const stamp = () => ({ id: nextId++, at: Date.now() });

export const usePanel = create<PanelState>((set) => ({
  task: "",
  running: false,
  tab: null,
  cdp: null,
  events: [],
  setTask: (task) => set({ task }),
  setRunning: (running) => set({ running }),
  setTab: (tab) => set({ tab }),
  setCdp: (cdp) => set({ cdp }),
  note: (level, text) =>
    set((s) => ({ events: [...s.events, { ...stamp(), kind: "note", level, text }] })),
  push: (event) => set((s) => ({ events: [...s.events, { ...stamp(), ...event }] })),
  clear: () => set({ events: [] }),
}));
