import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full resize-none rounded-lg border border-input bg-elevated px-3 py-2 text-xs leading-relaxed text-foreground shadow-sm transition-colors",
      "placeholder:text-muted-foreground/70",
      "focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
