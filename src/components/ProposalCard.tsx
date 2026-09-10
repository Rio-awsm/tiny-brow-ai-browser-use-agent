import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleSlash,
  Compass,
  Flag,
  Loader2,
  MousePointerClick,
  Play,
  Quote,
  RefreshCw,
  Keyboard,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeAction, isTerminal, type Proposal } from "@/lib/agent";

const ICON = {
  click: MousePointerClick,
  type: Keyboard,
  scroll: ArrowDown,
  navigate: Compass,
  extract: Quote,
  done: CircleCheck,
  fail: Flag,
} as const;

interface Props {
  proposal: Proposal;
  /** Null once the user has acted on it, so the card becomes a record. */
  state: "pending" | "executed" | "rejected";
  busy: boolean;
  onExecute: () => void;
  onReject: () => void;
}

export function ProposalCard({ proposal, state, busy, onExecute, onReject }: Props) {
  const { action } = proposal;
  const Icon =
    action.action === "scroll" && action.direction === "up" ? ArrowUp : ICON[action.action];

  const terminal = isTerminal(action);
  const blocked = proposal.problem !== null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border",
        blocked
          ? "border-destructive/30 bg-destructive/8"
          : state === "rejected"
            ? "border-border bg-card opacity-55"
            : "border-primary/25 bg-primary/8",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-md",
            blocked ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
          )}
        >
          <Icon className="size-3" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="break-words font-mono text-[11px] font-medium leading-relaxed">
            {describeAction(action)}
          </p>
          <p className="mt-0.5 break-words text-[10.5px] leading-relaxed text-muted-foreground">
            {action.reason}
          </p>
        </div>

        {state === "executed" && <CircleCheck className="mt-0.5 size-3 shrink-0 text-primary" />}
        {state === "rejected" && <CircleSlash className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
      </div>

      {blocked && (
        <p className="flex items-start gap-1.5 border-t border-destructive/20 px-2.5 py-1.5 text-[10px] leading-relaxed text-destructive">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          {proposal.problem}
        </p>
      )}

      {state === "pending" && (
        <div className="flex items-center gap-1.5 border-t border-border/60 px-2 py-1.5">
          <Button
            variant={blocked ? "outline" : "primary"}
            size="sm"
            onClick={onExecute}
            disabled={busy || blocked || terminal}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Play />}
            {terminal ? "Nothing to run" : "Execute"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onReject} disabled={busy}>
            {blocked ? <RefreshCw /> : <X />}
            {blocked ? "Ask again" : "Reject"}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-t border-border/60 px-2.5 py-1 font-mono text-[9px] tabular-nums text-muted-foreground">
        <span>{proposal.requestMs} ms</span>
        <span>
          {proposal.usage.prompt}p / {proposal.usage.completion}c
        </span>
        {proposal.cached > 0 && <span className="text-primary">{proposal.cached} cached</span>}
        <span className="ml-auto max-w-[45%] truncate">{proposal.model}</span>
      </div>
    </div>
  );
}
