import { Activity, Loader2, Plug, PlugZap, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface BenchState {
  on: boolean;
  connected: boolean;
  /** The task currently being run for the harness, if any. */
  current: string | null;
  completed: number;
  lastError: string | null;
}

interface Props {
  state: BenchState;
  onToggle: () => void;
}

/**
 * Only shown while benchmarking. The panel is otherwise the product surface,
 * and a permanent bench control would be clutter for everyone who never runs
 * the suite.
 */
export function BenchBar({ state, onToggle }: Props) {
  if (!state.on) return null;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-3 py-1.5",
        state.connected
          ? "border-info/25 bg-info/10"
          : "border-warning/25 bg-warning/10",
      )}
    >
      {state.current ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-info" />
      ) : state.connected ? (
        <PlugZap className="size-3 shrink-0 text-info" />
      ) : (
        <Plug className="size-3 shrink-0 text-warning" />
      )}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[10px] font-medium",
            state.connected ? "text-info" : "text-warning",
          )}
        >
          {state.current
            ? state.current
            : state.connected
              ? "Benchmark connected — waiting for the harness"
              : "Benchmark on — start the harness with --driver bridge"}
        </p>
        {state.lastError && (
          <p className="truncate text-[9px] text-destructive">{state.lastError}</p>
        )}
      </div>

      {state.completed > 0 && (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] tabular-nums text-muted-foreground">
          <Activity className="size-2.5" />
          {state.completed}
        </span>
      )}

      <Button variant="ghost" size="icon" onClick={onToggle}>
        <X />
      </Button>
    </div>
  );
}
