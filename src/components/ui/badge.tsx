import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide transition-colors",
  {
    variants: {
      variant: {
        neutral: "border-border bg-secondary text-muted-foreground",
        primary: "border-primary/25 bg-primary/12 text-primary",
        warning: "border-warning/25 bg-warning/12 text-warning",
        danger: "border-destructive/25 bg-destructive/12 text-destructive",
        info: "border-info/25 bg-info/12 text-info",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
