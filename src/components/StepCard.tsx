import { useState } from "react";
import {
  ArrowDown, ArrowUp, ChevronDown, CircleCheck, CircleSlash, Compass, Flag,
  Keyboard, Loader2, MessageCircleQuestion, MousePointerClick, Quote, TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { describeAction } from "@/lib/agent";
import type { PanelEvent } from "@/lib/store";

type Step = Extract<PanelEvent, { kind: "step" }>;

const ICON = {
  click: MousePointerClick, type: Keyboard, scroll: ArrowDown, navigate: Compass,
  extract: Quote,
  ask: MessageCircleQuestion, done: CircleCheck, fail: Flag,
} as const;

export function StepCard({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const action = step.action;
  const Icon =
    !action ? Loader2
    : action.action === "scroll" && action.direction === "up" ? ArrowUp
    : ICON[action.action];

  const tone =
    step.state === "bad" ? "border-destructive/25 bg-destructive/8"
    : step.state === "ok" ? "border-border bg-card"
    : "border-primary/25 bg-primary/8";

  return (
    <div className={cn("overflow-hidden rounded-lg border", tone)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/30"
      >
        <span className="mt-px w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
          {step.n}
        </span>
        <Icon
          className={cn(
            "mt-px size-3 shrink-0",
            !action && "animate-spin",
            step.state === "bad" ? "text-destructive" : "text-primary",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="break-words font-mono text-[10.5px] leading-relaxed">
            {action ? describeAction(action) : "thinking…"}
          </p>
          {step.outcome && (
            <p className="mt-0.5 break-words text-[10px] leading-relaxed text-muted-foreground">
              {step.outcome}
            </p>
          )}
        </div>
        {step.state === "acting" && <Loader2 className="mt-px size-3 shrink-0 animate-spin text-primary" />}
        {step.state === "bad" && <TriangleAlert className="mt-px size-3 shrink-0 text-destructive" />}
        <ChevronDown
          className={cn("mt-px size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="border-t border-border/60 px-2 py-1.5 pl-8">
          {action?.reason && (
            <p className="mb-1 break-words text-[10px] leading-relaxed text-muted-foreground">
              {action.reason}
            </p>
          )}
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
            <span>{step.indexSize}/{step.totalFound} elements</span>
            {step.usage && <span>{step.usage.prompt}p / {step.usage.completion}c</span>}
            {step.cached > 0 && <span className="text-primary">{step.cached} cached</span>}
            {step.thinkMs > 0 && <span>{step.thinkMs} ms</span>}
          </div>
          <p className="mt-1 break-all font-mono text-[9px] text-muted-foreground/70">{step.url}</p>
        </div>
      )}
    </div>
  );
}

export function RunSummary({ event }: { event: Extract<PanelEvent, { kind: "summary" }> }) {
  const { outcome } = event;
  const good = outcome.status === "done";
  const Icon = good ? CircleCheck : outcome.status === "stopped" ? CircleSlash : TriangleAlert;

  const label = {
    done: "Task complete", failed: "Could not finish", stopped: "Stopped",
    step_cap: "Hit the step cap", error: "Run error",
    needs_user: "Needs you",
  }[outcome.status];

  return (
    <div
      className={cn(
        "rounded-xl border px-2.5 py-2",
        good ? "border-primary/30 bg-primary/10" : "border-border bg-card",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", good ? "text-primary" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-[11px] font-semibold", good && "text-primary")}>{label}</p>
          {(outcome.answer || outcome.error) && (
            <p className="mt-1 break-words text-[11px] leading-relaxed text-foreground">
              {outcome.answer || outcome.error}
            </p>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-5.5 font-mono text-[9px] tabular-nums text-muted-foreground">
        <span>{outcome.steps} steps</span>
        <span>{(outcome.ms / 1000).toFixed(1)}s</span>
        <span>{outcome.usage.prompt + outcome.usage.completion} tokens</span>
        {(outcome.usage.cachedPrompt ?? 0) > 0 && (
          <span className="text-primary">{outcome.usage.cachedPrompt} cached</span>
        )}
      </div>
    </div>
  );
}
