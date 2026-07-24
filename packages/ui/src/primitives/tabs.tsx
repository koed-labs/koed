"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "../cn.js";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn("relative flex gap-4 border-b", className)}
      data-slot="tabs-list"
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative -mb-px min-h-9 border-b-2 border-transparent px-1 text-sm text-muted-foreground outline-none data-active:border-primary data-active:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn(
        "py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab, TabsTab as TabsTrigger };
