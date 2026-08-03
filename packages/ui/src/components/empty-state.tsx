import type * as React from "react";

import { cn } from "../cn.js";

function EmptyState({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-10 text-center",
        className
      )}
      data-slot="empty-state"
      {...props}
    />
  );
}

function EmptyStateTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("m-0 text-base font-semibold", className)}
      data-slot="empty-state-title"
      {...props}
    />
  );
}

function EmptyStateDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 text-sm text-muted-foreground", className)}
      data-slot="empty-state-description"
      {...props}
    />
  );
}

function EmptyStateActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-2 flex flex-wrap justify-center gap-2", className)}
      data-slot="empty-state-actions"
      {...props}
    />
  );
}

export {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateTitle
};
