import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../cn.js";

const badgeVariants = cva(
  "inline-flex min-h-5 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none",
  {
    defaultVariants: { variant: "neutral" },
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        primary: "border-primary/30 bg-primary/10 text-primary",
        memory: "border-memory/30 bg-memory/10 text-memory",
        success: "border-success/30 bg-success/10 text-success-foreground",
        warning: "border-warning/30 bg-warning/10 text-warning-foreground",
        destructive:
          "border-destructive/30 bg-destructive/10 text-destructive-foreground",
        outline: "bg-transparent text-foreground"
      }
    }
  }
);

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeProps };
