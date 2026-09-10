import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  Info,
  Layers,
  Maximize2,
  MousePointer2,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  estimateTokens,
  serializeIndex,
  serializeViewport,
  type PageIndex,
} from "@/lib/page-index";
import type { NoteLevel, PanelEvent } from "@/lib/store";
import type { Screenshot } from "@/lib/cdp-types";
import type { ActionResult } from "@/entrypoints/background/actions";
import { ProposalCard } from "@/components/ProposalCard";
import { RunSummary, StepCard } from "@/components/StepCard";

const NOTE: Record<NoteLevel, { icon: typeof Info; tone: string }> = {
  info: { icon: Info, tone: "text-muted-foreground" },
  sent: { icon: ArrowUpRight, tone: "text-info" },
  recv: { icon: ArrowDownLeft, tone: "text-primary" },
  error: { icon: TriangleAlert, tone: "text-destructive" },
};

interface TranscriptProps {
  events: PanelEvent[];
  busy: boolean;
  onExecute: (id: number) => void;
  onReject: (id: number) => void;
}

export function Transcript({ events, busy, onExecute, onReject }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Screenshot | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  if (events.length === 0) return <EmptyState />;

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 px-3 py-3">
          {events.map((e) => {
            switch (e.kind) {
              case "task":
                return <TaskBubble key={e.id} text={e.text} />;
              case "note":
                return <Note key={e.id} level={e.level} text={e.text} at={e.at} />;
              case "shot":
                return <ShotCard key={e.id} shot={e.shot} onZoom={() => setZoom(e.shot)} />;
              case "index":
                return <IndexCard key={e.id} index={e.index} />;
              case "command":
                return <CommandBubble key={e.id} input={e.input} />;
              case "action":
                return <ActionCard key={e.id} result={e.result} />;
              case "help":
                return <HelpCard key={e.id} text={e.text} />;
              case "step":
                return <StepCard key={e.id} step={e} />;
              case "summary":
                return <RunSummary key={e.id} event={e} />;
              case "proposal":
                return (
                  <ProposalCard
                    key={e.id}
                    proposal={e.proposal}
                    state={e.state}
                    busy={busy}
                    onExecute={() => onExecute(e.id)}
                    onReject={() => onReject(e.id)}
                  />
                );
            }
          })}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur animate-in fade-in-0"
          onClick={() => setZoom(null)}
        >
          <div className="flex justify-end p-2">
            <Button variant="ghost" size="icon" onClick={() => setZoom(null)}>
              <X />
            </Button>
          </div>
          <div className="flex-1 overflow-auto px-2 pb-2">
            <img
              src={zoom.dataUrl}
              alt="Captured page, enlarged"
              className="w-full rounded-lg border border-border"
            />
          </div>
        </div>
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Logo className="size-7 text-muted-foreground/40" />
      <div>
        <p className="text-[12px] font-medium">Drive this tab with a sentence</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          The agent loop lands in M9. Until then the tools below read the page the
          way it will.
        </p>
      </div>
    </div>
  );
}

function TaskBubble({ text }: { text: string }) {
  return (
    <div className="self-end max-w-[85%] rounded-xl rounded-br-sm bg-primary/12 px-3 py-2 text-[11px] leading-relaxed text-foreground">
      {text}
    </div>
  );
}

function CommandBubble({ input }: { input: string }) {
  return (
    <div className="flex items-center gap-1.5 self-end rounded-lg bg-secondary px-2 py-1 font-mono text-[10.5px] text-foreground">
      <Terminal className="size-3 shrink-0 text-muted-foreground" />
      {input}
    </div>
  );
}

function ActionCard({ result }: { result: ActionResult }) {
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/8 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <MousePointer2 className="mt-0.5 size-3 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 break-words font-mono text-[10.5px] leading-relaxed">
          {result.summary}
        </span>
        <span className="mt-0.5 shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">
          {result.tookMs} ms
        </span>
      </div>
      {(result.detail || result.at) && (
        <p className="mt-1 pl-5 font-mono text-[9px] text-muted-foreground">
          {result.at ? `at ${result.at.x},${result.at.y}` : ""}
          {result.at && result.detail ? " · " : ""}
          {result.detail ?? ""}
        </p>
      )}
    </div>
  );
}

function HelpCard({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-card px-2.5 py-2 font-mono text-[10px] leading-[1.6] text-foreground/85">
      {text}
    </pre>
  );
}

function Note({ level, text, at }: { level: NoteLevel; text: string; at: number }) {
  const { icon: Icon, tone } = NOTE[level];
  return (
    <div className="group flex items-start gap-2 px-0.5">
      <Icon className={cn("mt-0.5 size-3 shrink-0", tone)} />
      <span className="min-w-0 flex-1 break-words font-mono text-[10.5px] leading-relaxed text-foreground/85">
        {text}
      </span>
      <time className="mt-0.5 shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100">
        {new Date(at).toLocaleTimeString(undefined, { hour12: false })}
      </time>
    </div>
  );
}

function ShotCard({ shot, onZoom }: { shot: Screenshot; onZoom: () => void }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        onClick={onZoom}
        className="group relative block w-full transition-opacity hover:opacity-95"
      >
        <img src={shot.dataUrl} alt="Captured page" className="block w-full" />
        <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-background/85 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
          <Maximize2 className="size-3" />
        </span>
      </button>
      <figcaption className="flex items-center gap-2 border-t border-border px-2.5 py-1.5 font-mono text-[9px] tabular-nums text-muted-foreground">
        <span>
          {shot.width}×{shot.height}
        </span>
        <span>{(shot.bytes / 1024).toFixed(0)} kB</span>
        <span className="ml-auto">{shot.tookMs} ms</span>
      </figcaption>
    </figure>
  );
}

function IndexCard({ index }: { index: PageIndex }) {
  const [open, setOpen] = useState(false);
  const serialized = serializeIndex(index.elements);
  const tokens = estimateTokens(serialized);
  const truncated = index.totalFound > index.elements.length;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/40"
      >
        <Layers className="size-3.5 shrink-0 text-primary" />
        <span className="text-[11px] font-medium">
          {index.elements.length} element{index.elements.length === 1 ? "" : "s"}
        </span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-mono text-[9px] tabular-nums",
            tokens > 2000
              ? "bg-destructive/12 text-destructive"
              : "bg-secondary text-muted-foreground",
          )}
        >
          ~{tokens} tok
        </span>
        {truncated && (
          <span className="font-mono text-[9px] text-muted-foreground">
            of {index.totalFound}
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground">
          {index.tookMs} ms
        </span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border">
          <p className="px-2.5 pt-2 font-mono text-[9px] text-muted-foreground">
            {serializeViewport(index.viewport)} · {index.textChars} chars of text
          </p>
          <pre className="max-h-72 overflow-auto px-2.5 pb-2.5 pt-1.5 font-mono text-[10px] leading-[1.55] text-foreground/85">
            {serialized || "(no interactive elements found)"}
          </pre>
        </div>
      )}
    </div>
  );
}
