import { CornerDownLeft, Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const SUGGESTIONS = [
  "Go to example.com and tell me the page title",
  "Search Wikipedia for Chandrayaan-3",
  "Find the top 3 wireless mice on Amazon.in",
];

interface Props {
  task: string;
  running: boolean;
  onChange: (task: string) => void;
  onRun: () => void;
  onStop: () => void;
}

export function TaskComposer({ task, running, onChange, onRun, onStop }: Props) {
  const empty = task.trim().length === 0;

  return (
    <div className="border-b border-border px-3 py-3">
      <Textarea
        value={task}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) onRun();
        }}
        rows={3}
        spellCheck={false}
        placeholder="Describe a task in plain English…"
        disabled={running}
      />

      {empty && !running && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onChange(s)}
              className="rounded-full border border-border bg-secondary/60 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-ring/40 hover:bg-accent hover:text-accent-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        {running ? (
          <Button variant="destructive" size="md" onClick={onStop}>
            <Square />
            Stop
          </Button>
        ) : (
          <Button variant="primary" size="md" onClick={onRun} disabled={empty}>
            <Play />
            Run
          </Button>
        )}

        {running ? (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            working
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <CornerDownLeft className="size-3" />
            Ctrl + Enter
          </span>
        )}
      </div>
    </div>
  );
}
