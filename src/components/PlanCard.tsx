import { AlertTriangle, BadgeCheck, ListOrdered, RefreshCw, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanProps {
  steps: string[];
  watchOut: string;
  /** A second plan, written because the first one got the run stuck. */
  replanned: boolean;
}

/** What Tiny intends, before it starts — so you can stop it before it does. */
export function PlanCard({ steps, watchOut, replanned }: PlanProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          {replanned ? <RefreshCw className="size-3" /> : <ListOrdered className="size-3" />}
        </span>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {replanned ? "New plan" : "Plan"}
        </p>
      </div>
      <ol className="flex flex-col gap-1 px-2.5 py-2">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span className="shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
            <span className="min-w-0 break-words">{step}</span>
          </li>
        ))}
      </ol>
      {watchOut ? (
        <p className="flex items-start gap-1.5 border-t border-border/60 px-2.5 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-px size-3 shrink-0 text-warning" />
          <span className="min-w-0 break-words">{watchOut}</span>
        </p>
      ) : null}
    </div>
  );
}

interface VerdictProps {
  met: boolean;
  why: string;
}

/** The second opinion on a finished run, shown whether or not it agreed. */
export function VerdictNote({ met, why }: VerdictProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5",
        met ? "border-border bg-card" : "border-warning/35 bg-warning/10",
      )}
    >
      {met ? (
        <BadgeCheck className="mt-px size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ShieldQuestion className="mt-px size-3 shrink-0 text-warning" />
      )}
      <p className="min-w-0 break-words text-[10px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">
          {met ? "Checked" : "Answer sent back"}
        </span>{" "}
        — {why}
      </p>
    </div>
  );
}
