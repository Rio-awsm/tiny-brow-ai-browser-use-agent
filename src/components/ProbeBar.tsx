import { Eraser, MousePointerClick, RefreshCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  busy: boolean;
  hasLog: boolean;
  onPing: () => void;
  onRefreshTab: () => void;
  onProbePage: () => void;
  onClear: () => void;
}

export function ProbeBar({
  busy,
  hasLog,
  onPing,
  onRefreshTab,
  onProbePage,
  onClear,
}: Props) {
  return (
    <div className="flex items-center gap-1.5 border-t border-border bg-surface/60 px-3 py-2">
      <Probe label="Round-trip a message through the background worker" onClick={onPing} disabled={busy}>
        <Zap />
        Ping
      </Probe>
      <Probe label="Re-read the active tab" onClick={onRefreshTab} disabled={busy}>
        <RefreshCw />
        Tab
      </Probe>
      <Probe label="Ask the content script what it can see" onClick={onProbePage} disabled={busy}>
        <MousePointerClick />
        Page
      </Probe>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            disabled={!hasLog}
            className="ml-auto"
          >
            <Eraser />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Clear log</TooltipContent>
      </Tooltip>
    </div>
  );
}

function Probe({
  label,
  children,
  ...props
}: { label: string } & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
