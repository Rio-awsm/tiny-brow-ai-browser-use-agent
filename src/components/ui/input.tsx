import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-lg border border-input bg-elevated px-2.5 text-xs text-foreground shadow-sm transition-colors",
      "placeholder:text-muted-foreground/60",
      "focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
