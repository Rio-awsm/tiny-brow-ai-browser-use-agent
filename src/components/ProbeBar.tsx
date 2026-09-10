import { Eraser, MousePointerClick, RefreshCw, Zap } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip-button";

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
      <TooltipButton
        tip="Round-trip a message through the background worker"
        variant="outline"
        size="sm"
        onClick={onPing}
        disabled={busy}
      >
        <Zap />
        Ping
      </TooltipButton>
      <TooltipButton tip="Re-read the active tab" variant="outline" size="sm" onClick={onRefreshTab} disabled={busy}>
        <RefreshCw />
        Tab
      </TooltipButton>
      <TooltipButton
        tip="Ask the content script what it can see"
        variant="outline"
        size="sm"
        onClick={onProbePage}
        disabled={busy}
      >
        <MousePointerClick />
        Page
      </TooltipButton>

      <TooltipButton
        tip="Clear log"
        variant="ghost"
        size="icon"
        onClick={onClear}
        disabled={!hasLog}
        className="ml-auto"
      >
        <Eraser />
      </TooltipButton>
    </div>
  );
}

