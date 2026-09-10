import { Check, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalRequest } from "@/lib/agent/loop";

interface Props {
  request: ApprovalRequest;
  /** Null until you decide, which turns the card into a record of what happened. */
  answer: boolean | null;
  onAnswer: (allowed: boolean) => void;
}

/**
 * The stop before something irreversible.
 *
 * It states the action in full — the verb, the element's own label, the page it
 * is on — because an approval that only says "continue?" trains you to click
 * yes. Nothing is pre-selected and neither button is the default.
 */
export function ApprovalCard({ request, answer, onAnswer }: Props) {
  const pending = answer === null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border",
        pending ? "border-destructive/40 bg-destructive/10" : "border-border bg-card opacity-70",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-md",
            pending ? "bg-destructive/20 text-destructive" : "bg-secondary text-muted-foreground",
          )}
        >
          <ShieldAlert className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Tiny wants to
          </p>
          <p className="mt-0.5 break-words text-[11px] font-medium leading-relaxed">
            {request.what}
          </p>
          <p className="mt-1 break-words text-[10px] leading-relaxed text-muted-foreground">
            {request.because}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">{request.url}</p>
        </div>
      </div>

      {pending ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-destructive/25 px-2 py-2">
          <Button variant="primary" size="sm" onClick={() => onAnswer(true)}>
            <Check />
            Allow once
          </Button>
          <Button variant="outline" size="sm" onClick={() => onAnswer(false)}>
            <X />
            Don't
          </Button>
        </div>
      ) : (
        <p className="border-t border-border/60 px-2.5 py-1.5 text-[10px] text-muted-foreground">
          {answer ? "You allowed it" : "You did not allow it"}
        </p>
      )}
    </div>
  );
}
