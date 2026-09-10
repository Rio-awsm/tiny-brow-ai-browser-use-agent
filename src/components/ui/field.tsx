import { cn } from "@/lib/utils";

interface Props {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className }: Props) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[10px] text-destructive">{error}</span>}
    </label>
  );
}
