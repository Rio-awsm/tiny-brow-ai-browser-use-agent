import { Globe, Radio, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TabInfo } from "@/lib/messaging";

interface Props {
  tab: TabInfo | null;
  connected: boolean;
}

export function PanelHeader({ tab, connected }: Props) {
  const host = safeHost(tab?.url);

  return (
    <header className="border-b border-border bg-surface/80 px-3 py-2.5 backdrop-blur">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary/12 text-primary">
            <Radio className="size-3.5" />
          </div>
          <div className="leading-none">
            <div className="text-[13px] font-semibold tracking-tight">tiny-brow</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              milestone 1 · shell
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={connected ? "primary" : "danger"}>
                <span
                  className={`size-1.5 rounded-full ${
                    connected ? "bg-primary" : "bg-destructive"
                  }`}
                />
                {connected ? "linked" : "offline"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {connected
                ? "Background service worker is responding"
                : "No reply from the background service worker"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled>
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Settings arrive in M15</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-border/70 bg-elevated px-2 py-1.5">
        <Globe className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-[11px] text-muted-foreground" title={tab?.url}>
          {host ?? "no active tab"}
        </span>
        {tab?.title && (
          <span className="ml-auto max-w-[45%] truncate text-[10px] text-muted-foreground/70">
            {tab.title}
          </span>
        )}
      </div>
    </header>
  );
}

function safeHost(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : url;
  } catch {
    return url;
  }
}
