import type * as React from "react";

import { cn } from "../cn.js";

function Stack({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-4", className)}
      data-slot="stack"
      {...props}
    />
  );
}

function Cluster({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
      data-slot="cluster"
      {...props}
    />
  );
}

function AppFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid h-svh min-h-0 min-w-0 grid-cols-1 overflow-hidden bg-background text-foreground",
        className
      )}
      data-slot="app-frame"
      {...props}
    />
  );
}

function Pane({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("min-h-0 min-w-0 overflow-auto", className)}
      data-slot="pane"
      {...props}
    />
  );
}

function Toolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-12 min-w-0 items-center gap-2 border-b px-4",
        className
      )}
      data-slot="toolbar"
      role="toolbar"
      {...props}
    />
  );
}

export { AppFrame, Cluster, Pane, Stack, Toolbar };
