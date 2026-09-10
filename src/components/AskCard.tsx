import { useState } from "react";
import { CircleSlash, Hand, Play, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AskReply, AskRequest } from "@/lib/agent/loop";

interface Props {
  request: AskRequest;
  /** Null once answered, which turns the card into a record of what happened. */
  answer: AskReply | null;
  onAnswer: (reply: AskReply) => void;
}

/**
 * The handoff. Tiny stops, says what it cannot do, and waits for you.
 *
 * Signing in is not something an agent should do on your behalf even when it
 * could: the credentials are yours, and a page that asks for them is exactly
 * where an agent battering at listed elements looks locally reasonable while
 * making no progress at all.
 */
export function AskCard({ request, answer, onAnswer }: Props) {
  const [note, setNote] = useState("");

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border",
        answer ? "border-border bg-card opacity-70" : "border-warning/35 bg-warning/10",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-md",
            answer ? "bg-secondary text-muted-foreground" : "bg-warning/20 text-warning",
          )}
        >
          <Hand className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[11px] font-medium leading-relaxed">
            {request.question}
          </p>
          <p className="mt-0.5 break-words text-[10px] leading-relaxed text-muted-foreground">
            {request.because}
          </p>
        </div>
      </div>

      {answer ? (
        <p className="border-t border-border/60 px-2.5 py-1.5 text-[10px] text-muted-foreground">
          {answer.action === "continue"
            ? `You continued${answer.note ? `: ${answer.note}` : ""}`
            : answer.action === "skip"
              ? `You skipped${answer.note ? `: ${answer.note}` : ""}`
              : "You stopped the run"}
        </p>
      ) : (
        <div className="border-t border-warning/25 px-2 py-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAnswer({ action: "continue", note: note.trim() });
            }}
            placeholder="Anything Tiny should know — optional"
            className="mb-1.5"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              onClick={() => onAnswer({ action: "continue", note: note.trim() })}
            >
              <Play />
              I've done it — continue
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAnswer({ action: "skip", note: note.trim() })}
            >
              <SkipForward />
              Skip
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onAnswer({ action: "stop", note: note.trim() })}
            >
              <CircleSlash />
              Stop
            </Button>
          </div>
          <p className="mt-1.5 text-[9.5px] leading-relaxed text-muted-foreground">
            Sign in yourself in the tab, then continue. Tiny never types passwords,
            one-time codes or card details.
          </p>
        </div>
      )}
    </div>
  );
}
