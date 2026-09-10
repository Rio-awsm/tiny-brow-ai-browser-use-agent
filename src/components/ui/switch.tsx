import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent",
        "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-background shadow-sm ring-0",
          "transition-transform data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

interface RowProps {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** A switch with its explanation, which is the only form a setting should take. */
export function SwitchRow({ label, hint, checked, onCheckedChange }: RowProps) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[11px] font-medium">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="mt-0.5" />
    </label>
  );
}
