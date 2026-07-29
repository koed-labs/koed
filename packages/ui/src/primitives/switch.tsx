"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../cn.js";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 cursor-pointer items-center rounded-full border border-input bg-muted p-0.5 outline-none transition-colors duration-150 data-checked:border-primary data-checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-3.5 rounded-full bg-background shadow-xs transition-[margin] duration-150 data-checked:ml-4" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
