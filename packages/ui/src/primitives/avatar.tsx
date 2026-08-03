import type * as React from "react";

import { cn } from "../cn.js";

type AvatarProps = React.ComponentProps<"span"> & {
  presence?: "available" | "away" | "offline";
};

function Avatar({ className, presence, children, ...props }: AvatarProps) {
  return (
    <span
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center overflow-visible rounded-md bg-muted text-sm font-medium text-muted-foreground",
        className
      )}
      data-slot="avatar"
      {...props}
    >
      {children}
      {presence ? (
        <span
          aria-label={presence}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
            presence === "available" && "bg-presence-available",
            presence === "away" && "bg-presence-away",
            presence === "offline" && "bg-muted-foreground"
          )}
          data-slot="avatar-presence"
          role="img"
        />
      ) : null}
    </span>
  );
}

function AvatarImage({
  className,
  alt,
  ...props
}: React.ComponentProps<"img">) {
  return (
    <img
      alt={alt}
      className={cn("size-full rounded-[inherit] object-cover", className)}
      data-slot="avatar-image"
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex size-full items-center justify-center rounded-[inherit]",
        className
      )}
      data-slot="avatar-fallback"
      {...props}
    />
  );
}

export { Avatar, AvatarFallback, AvatarImage, type AvatarProps };
