import { create } from "zustand";
import type { CdpStatus, Screenshot } from "./cdp-types";
import type { TabInfo } from "./messaging";
import type { PageIndex } from "./page-index";
import type { ActionResult } from "@/entrypoints/background/actions";
import type { AgentAction, Proposal } from "@/lib/agent";
import type { AskReply, AskRequest, RunOutcome } from "@/lib/agent/loop";
import type { TokenUsage } from "@/lib/provider";

export type NoteLevel = "info" | "sent" | "recv" | "error";

interface Base {
  id: number;
  at: number;
}

export type PanelEvent =
  | (Base & { kind: "note"; level: NoteLevel; text: string })
  | (Base & { kind: "task"; text: string })
  | (Base & { kind: "shot"; shot: Screenshot })
  | (Base & { kind: "index"; index: PageIndex })
  | (Base & { kind: "command"; input: string })
  | (Base & { kind: "action"; result: ActionResult })
  | (Base & { kind: "help"; text: string })
  | (Base & {
      kind: "proposal";
      proposal: Proposal;
      state: "pending" | "executed" | "rejected";
    })
  | (Base & {
      kind: "step";
      n: number;
      url: string;
      title: string;
      indexSize: number;
      totalFound: number;
      action: AgentAction | null;
      usage: TokenUsage | null;
      cached: number;
      thinkMs: number;
      outcome: string;
      state: "thinking" | "acting" | "ok" | "bad";
    })
  | (Base & { kind: "summary"; outcome: RunOutcome; task: string })
  | (Base & { kind: "ask"; request: AskRequest; answer: AskReply | null });

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
  /** Proposal and step cards are written before their outcome is known. */
  resolveProposal: (id: number, state: "executed" | "rejected") => void;
  patchStep: (id: number, patch: Partial<Extract<PanelEvent, { kind: "step" }>>) => void;
  answerAsk: (id: number, answer: AskReply) => void;
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
  patchStep: (id, patch) =>
    set((s) => ({
      events: s.events.map((e) => (e.id === id && e.kind === "step" ? { ...e, ...patch } : e)),
    })),
  answerAsk: (id, answer) =>
    set((s) => ({
      events: s.events.map((e) => (e.id === id && e.kind === "ask" ? { ...e, answer } : e)),
    })),
  resolveProposal: (id, state) =>
    set((s) => ({
      events: s.events.map((e) =>
        e.id === id && e.kind === "proposal" ? { ...e, state } : e,
      ),
    })),
  clear: () => set({ events: [] }),
}));
