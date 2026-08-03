"use client";

import { SearchIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "../cn.js";

function Command({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground",
        className
      )}
      data-slot="command"
      {...props}
    />
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <label className="flex min-h-10 items-center gap-2 border-b px-3">
      <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <input
        aria-autocomplete="list"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground",
          className
        )}
        data-slot="command-input"
        role="combobox"
        type="search"
        {...props}
      />
    </label>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("max-h-80 overflow-y-auto p-1", className)}
      data-slot="command-list"
      role="listbox"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  label,
  children,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
  return (
    <div
      aria-label={label}
      className={cn("py-1", className)}
      data-slot="command-group"
      role="group"
      {...props}
    >
      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      data-slot="command-item"
      role="option"
      type="button"
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "m-0 px-3 py-8 text-center text-sm text-muted-foreground",
        className
      )}
      data-slot="command-empty"
      {...props}
    />
  );
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
};
