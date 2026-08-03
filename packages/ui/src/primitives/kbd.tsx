import type * as React from "react";

import { cn } from "../cn.js";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex min-h-5 min-w-5 items-center justify-center rounded-sm border bg-muted px-1 font-mono text-[11px] text-muted-foreground",
        className
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

export { Kbd };
