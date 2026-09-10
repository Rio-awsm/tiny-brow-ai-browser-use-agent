import { Eraser, Settings } from "lucide-react";
import { Logo } from "@/components/Logo";
import { TooltipButton } from "@/components/ui/tooltip-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CdpStatus } from "@/lib/cdp-types";
import type { TabInfo } from "@/lib/messaging";

interface Props {
  tab: TabInfo | null;
  cdp: CdpStatus | null;
  hasEvents: boolean;
  onClear: () => void;
}

export function PanelHeader({ tab, cdp, hasEvents, onClear }: Props) {
  const state = cdp?.state ?? "detached";
  const attached = state === "attached";
  const foreign = attached && !cdp?.owned;

  const dot = foreign
    ? "bg-warning"
    : attached
      ? "bg-primary"
      : state === "restricted"
        ? "bg-warning"
        : "bg-muted-foreground/45";

  const explain = foreign
    ? "A debugger is attached by something else"
    : attached
      ? "Debugger attached — Chrome shows its banner while this lasts"
      : state === "restricted"
        ? (cdp?.reason ?? "This page cannot be driven")
        : "Not attached";

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <Logo className="size-[18px] text-primary" />
      <span className="text-[13px] font-semibold tracking-tight">tiny-brow</span>

      <Tooltip>
        <TooltipTrigger asChild>
          <button className="ml-auto flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent">
            <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="max-w-[130px] truncate text-[11px] text-muted-foreground">
              {hostOf(tab?.url) ?? "no page"}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[220px]">
          {explain}
        </TooltipContent>
      </Tooltip>

      {hasEvents && (
        <TooltipButton
          tip="Clear session"
          side="bottom"
          variant="ghost"
          size="icon"
          onClick={onClear}
        >
          <Eraser />
        </TooltipButton>
      )}

      <TooltipButton tip="Settings arrive in M15" side="bottom" variant="ghost" size="icon" disabled>
        <Settings />
      </TooltipButton>
    </header>
  );
}

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:"
      ? u.host.replace(/^www\./, "")
      : u.protocol.replace(":", "");
  } catch {
    return url.slice(0, 24);
  }
}
