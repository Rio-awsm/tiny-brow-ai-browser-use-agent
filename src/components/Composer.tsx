import { useState } from "react";
import {
  ArrowUp,
  Camera,
  ChevronUp,
  Layers,
  Link2,
  Link2Off,
  Loader2,
  MousePointerClick,
  ScanEye,
  Square,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipButton } from "@/components/ui/tooltip-button";
import { cn } from "@/lib/utils";
import { parseCommand } from "@/lib/commands";
import type { CdpStatus } from "@/lib/cdp-types";

export type ToolId =
  | "attach"
  | "detach"
  | "capture"
  | "index"
  | "overlay"
  | "ping"
  | "tab"
  | "page";

interface Props {
  task: string;
  running: boolean;
  cdp: CdpStatus | null;
  busyTool: ToolId | null;
  overlayOn: boolean;
  onChange: (task: string) => void;
  onRun: () => void;
  onStop: () => void;
  onTool: (tool: ToolId) => void;
}

export function Composer({
  task,
  running,
  cdp,
  busyTool,
  overlayOn,
  onChange,
  onRun,
  onStop,
  onTool,
}: Props) {
  const [tools, setTools] = useState(false);
  const empty = task.trim().length === 0;
  const parsed = parseCommand(task);
  const attached = cdp?.state === "attached";
  const restricted = cdp?.state === "restricted";
  const busy = busyTool !== null;

  return (
    <div className="shrink-0 border-t border-border bg-surface/60">
      {tools && (
        <div className="grid grid-cols-3 gap-1 border-b border-border px-2 py-2">
          {attached ? (
            <Tool
              id="detach"
              label="Detach"
              icon={Link2Off}
              tip="Release the debugger and remove Chrome's banner"
              busyTool={busyTool}
              onTool={onTool}
            />
          ) : (
            <Tool
              id="attach"
              label="Attach"
              icon={Link2}
              tip="Open a CDP session and keep it open"
              disabled={restricted}
              busyTool={busyTool}
              onTool={onTool}
            />
          )}
          <Tool
            id="index"
            label="Index"
            icon={Layers}
            tip="Build the numbered element index the model will act on"
            disabled={restricted}
            busyTool={busyTool}
            onTool={onTool}
          />
          <Tool
            id="overlay"
            label={overlayOn ? "Hide" : "Overlay"}
            icon={ScanEye}
            tip={
              overlayOn
                ? "Remove the numbered boxes from the page"
                : "Draw numbered boxes over everything in the index"
            }
            disabled={restricted}
            active={overlayOn}
            busyTool={busyTool}
            onTool={onTool}
          />
          <Tool
            id="capture"
            label="Shot"
            icon={Camera}
            tip="Screenshot the viewport over CDP"
            disabled={restricted}
            busyTool={busyTool}
            onTool={onTool}
          />
          <Tool
            id="ping"
            label="Ping"
            icon={Zap}
            tip="Round-trip a message through the background worker"
            busyTool={busyTool}
            onTool={onTool}
          />
          <Tool
            id="page"
            label="Probe"
            icon={MousePointerClick}
            tip="Ask the content script what it can see"
            busyTool={busyTool}
            onTool={onTool}
          />
        </div>
      )}

      {parsed && (
        <p
          className={cn(
            "flex items-center gap-1.5 border-b border-border px-3 py-1.5 font-mono text-[10px]",
            parsed.ok
              ? "bg-primary/8 text-primary"
              : "bg-destructive/8 text-destructive",
          )}
        >
          <Terminal className="size-2.5 shrink-0" />
          {parsed.ok ? parsed.summary : parsed.error}
        </p>
      )}

      {restricted && cdp?.reason && (
        <p className="border-b border-border bg-warning/8 px-3 py-1.5 text-[10px] leading-relaxed text-warning">
          {cdp.reason}
        </p>
      )}

      <div className="p-2.5">
        <div className="relative">
          <Textarea
            value={task}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!empty && !running) onRun();
              }
            }}
            rows={2}
            spellCheck={false}
            placeholder="Ask Tiny to do something, or run a command like /click 7"
            disabled={running}
            className="pr-11"
          />
          <div className="absolute bottom-1.5 right-1.5">
            {running ? (
              <Button variant="destructive" size="icon" onClick={onStop}>
                <Square />
              </Button>
            ) : (
              <Button variant="primary" size="icon" onClick={onRun} disabled={empty}>
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-2 px-0.5">
          <button
            onClick={() => setTools((v) => !v)}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
              tools
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Wrench className="size-2.5" />
            Tools
            <ChevronUp
              className={cn("size-2.5 transition-transform", tools && "rotate-180")}
            />
          </button>

          {busy && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="size-2.5 animate-spin" />
              {busyTool}
            </span>
          )}

          <span className="ml-auto text-[10px] text-muted-foreground/60">
            {parsed?.ok ? "Enter to run" : "Enter to send"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Tool({
  id,
  label,
  icon: Icon,
  tip,
  disabled,
  active,
  busyTool,
  onTool,
}: {
  id: ToolId;
  label: string;
  icon: typeof Zap;
  tip: string;
  disabled?: boolean;
  active?: boolean;
  busyTool: ToolId | null;
  onTool: (t: ToolId) => void;
}) {
  return (
    <TooltipButton
      tip={tip}
      variant={active ? "primary" : "outline"}
      size="sm"
      disabled={disabled || busyTool !== null}
      onClick={() => onTool(id)}
      className="h-11 flex-col gap-0.5 px-1 text-[9px] font-normal"
    >
      {busyTool === id ? <Loader2 className="animate-spin" /> : <Icon />}
      {label}
    </TooltipButton>
  );
}
