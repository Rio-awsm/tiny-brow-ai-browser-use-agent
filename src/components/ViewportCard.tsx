import { useState } from "react";
import {
  Camera,
  CircleAlert,
  Link2,
  Link2Off,
  Loader2,
  Maximize2,
  Monitor,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip-button";
import type { CdpStatus, Screenshot } from "@/lib/cdp-types";

interface Props {
  status: CdpStatus | null;
  shot: Screenshot | null;
  busy: "attach" | "detach" | "capture" | null;
  onAttach: () => void;
  onDetach: () => void;
  onCapture: () => void;
}

export function ViewportCard({
  status,
  shot,
  busy,
  onAttach,
  onDetach,
  onCapture,
}: Props) {
  const [zoom, setZoom] = useState(false);
  const state = status?.state ?? "detached";
  const attached = state === "attached";
  const restricted = state === "restricted";
  const foreign = attached && !status?.owned;

  return (
    <section className="border-b border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Monitor className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium tracking-tight">Viewport</span>

        <Badge
          variant={foreign ? "warning" : attached ? "primary" : restricted ? "warning" : "neutral"}
          className="ml-1"
        >
          <span
            className={`size-1.5 rounded-full ${
              foreign
                ? "bg-warning"
                : attached
                  ? "animate-pulse bg-primary"
                  : restricted
                    ? "bg-warning"
                    : "bg-muted-foreground/60"
            }`}
          />
          {attached
            ? foreign
              ? "external"
              : status?.pinned
                ? "attached"
                : "transient"
            : state}
        </Badge>

        <div className="ml-auto flex items-center gap-1">
          {attached ? (
            <TooltipButton
              tip={
                foreign
                  ? "Try to release the debugger held on this tab"
                  : "Detach the debugger"
              }
              variant="outline"
              size="icon"
              onClick={onDetach}
              disabled={busy !== null}
            >
              {busy === "detach" ? <Loader2 className="animate-spin" /> : <Link2Off />}
            </TooltipButton>
          ) : (
            <TooltipButton
              tip="Attach the debugger and keep the session open"
              variant="outline"
              size="icon"
              onClick={onAttach}
              disabled={busy !== null || restricted}
            >
              {busy === "attach" ? <Loader2 className="animate-spin" /> : <Link2 />}
            </TooltipButton>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onCapture}
            disabled={busy !== null || restricted}
          >
            {busy === "capture" ? <Loader2 className="animate-spin" /> : <Camera />}
            Capture
          </Button>
        </div>
      </div>

      {(restricted || foreign) && status?.reason && (
        <Notice tone="warning" icon={TriangleAlert} text={status.reason} />
      )}
      {!restricted && !attached && status?.reason && (
        <Notice tone="muted" icon={CircleAlert} text={status.reason} />
      )}
      {attached && !foreign && (
        <Notice
          tone="muted"
          icon={CircleAlert}
          text="Chrome shows a yellow debugging banner while attached. It cannot be hidden."
        />
      )}

      {shot ? (
        <figure className="mt-2">
          <button
            onClick={() => setZoom(true)}
            className="group relative block w-full overflow-hidden rounded-lg border border-border bg-elevated transition-colors hover:border-ring/50"
          >
            <img
              src={shot.dataUrl}
              alt="Live capture of the attached tab"
              className="block w-full"
            />
            <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-background/85 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              <Maximize2 className="size-3" />
            </span>
          </button>
          <figcaption className="mt-1.5 flex items-center gap-2 font-mono text-[9px] tabular-nums text-muted-foreground">
            <span>
              {shot.width}×{shot.height}
            </span>
            <span>{(shot.bytes / 1024).toFixed(0)} kB</span>
            <span>{shot.tookMs} ms</span>
            <span className="ml-auto">
              {new Date(shot.capturedAt).toLocaleTimeString(undefined, {
                hour12: false,
              })}
            </span>
          </figcaption>
        </figure>
      ) : (
        <div className="mt-2 flex h-20 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/30">
          <p className="text-[10px] text-muted-foreground">
            {restricted ? "Nothing to capture here" : "No capture yet"}
          </p>
        </div>
      )}

      {zoom && shot && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur animate-in fade-in-0"
          onClick={() => setZoom(false)}
        >
          <div className="flex items-center justify-end p-2">
            <Button variant="ghost" size="icon" onClick={() => setZoom(false)}>
              <X />
            </Button>
          </div>
          <div className="flex-1 overflow-auto px-2 pb-2">
            <img
              src={shot.dataUrl}
              alt="Live capture of the attached tab, enlarged"
              className="w-full rounded-lg border border-border"
            />
          </div>
        </div>
      )}
    </section>
  );
}

function Notice({
  tone,
  icon: Icon,
  text,
}: {
  tone: "warning" | "muted";
  icon: typeof CircleAlert;
  text: string;
}) {
  return (
    <p
      className={`mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[10px] leading-relaxed ${
        tone === "warning"
          ? "border-warning/25 bg-warning/10 text-warning"
          : "border-border bg-secondary/40 text-muted-foreground"
      }`}
    >
      <Icon className="mt-px size-3 shrink-0" />
      {text}
    </p>
  );
}

