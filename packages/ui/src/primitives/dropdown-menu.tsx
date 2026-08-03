"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon } from "lucide-react";

import { cn } from "../cn.js";

const DropdownMenu = MenuPrimitive.Root;
const DropdownMenuTrigger = MenuPrimitive.Trigger;
const DropdownMenuGroup = MenuPrimitive.Group;
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

function DropdownMenuPopup({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  align?: MenuPrimitive.Positioner.Props["align"];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        className="z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "min-w-44 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md/10 outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className
          )}
          data-slot="dropdown-menu-popup"
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className
      )}
      data-slot="dropdown-menu-item"
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn(
        "grid min-h-8 cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-md px-2 outline-none data-disabled:opacity-50 data-highlighted:bg-accent",
        className
      )}
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator>
        <CheckIcon className="size-3.5" />
      </MenuPrimitive.CheckboxItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      role="separator"
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPopup,
  DropdownMenuPopup as DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger
};
