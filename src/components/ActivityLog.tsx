import { useEffect, useRef } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Info,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { LogEntry, LogLevel } from "@/lib/store";

const STYLES: Record<LogLevel, { icon: typeof Info; tone: string }> = {
  info: { icon: Info, tone: "text-muted-foreground" },
  sent: { icon: ArrowUpRight, tone: "text-info" },
  recv: { icon: ArrowDownLeft, tone: "text-primary" },
  error: { icon: TriangleAlert, tone: "text-destructive" },
};

export function ActivityLog({ log }: { log: LogEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length]);

  if (log.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground">
          <Terminal className="size-4" />
        </div>
        <p className="text-[11px] font-medium text-foreground">No activity yet</p>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          The agent loop lands in M9. For now, use the probes below to check the
          panel, background worker and content script are talking to each other.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <ol className="flex flex-col gap-px p-2">
        {log.map((e) => {
          const { icon: Icon, tone } = STYLES[e.level];
          return (
            <li
              key={e.id}
              className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
            >
              <Icon className={cn("mt-px size-3 shrink-0", tone)} />
              <span className="min-w-0 flex-1 break-words font-mono text-[11px] leading-relaxed text-foreground/90">
                {e.text}
              </span>
              <time className="mt-px shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100">
                {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
              </time>
            </li>
          );
        })}
      </ol>
      <div ref={endRef} />
    </ScrollArea>
  );
}
