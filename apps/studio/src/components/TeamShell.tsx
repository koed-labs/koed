"use client";

import { PanelLeft } from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { Tooltip } from "./Tooltip";
import { useTheme } from "./ThemeProvider";

export function TeamShell({
  crumbs,
  heading,
  children,
  footer,
  aside,
  wallpaper = false,
  subheader,
  chatLayout = false
}: {
  crumbs?: string[];
  heading?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  aside?: React.ReactNode;
  wallpaper?: boolean;
  subheader?: React.ReactNode;
  chatLayout?: boolean;
}) {
  const { isOpen, toggleSidebar } = useSidebar();
  const hasHeaderText = Boolean(heading) || Boolean(crumbs?.length);
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header
        className={`z-10 flex min-w-0 items-center px-3 sm:px-4 bg-background/80 backdrop-blur-sm drag-region ${
          hasHeaderText ? "h-14 pt-4" : "py-2"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3 no-drag">
          {!isOpen && (
            <Tooltip content="Open Sidebar" side="bottom">
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label="Open team navigation"
                aria-controls="team-navigation"
                aria-expanded={false}
                className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          {heading ? (
            <p className="min-w-0 truncate text-sm text-foreground">
              {heading}
            </p>
          ) : (
            <div className="min-w-0 truncate text-sm text-muted">
              {(crumbs ?? []).map((crumb, index) => (
                <span key={`${crumb}-${index}`}>
                  {index > 0 && <span className="mx-2 text-faint">/</span>}
                  <span
                    className={
                      index === crumbs!.length - 1
                        ? "text-foreground"
                        : "text-foreground-secondary"
                    }
                  >
                    {crumb}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </header>
      {subheader}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {wallpaper && <ChannelWallpaper />}
          <main
            className={`relative min-h-0 min-w-0 flex-1 ${chatLayout ? "flex flex-col overflow-hidden p-2 sm:p-4" : "overflow-y-auto p-4"}`}
          >
            {children}
          </main>
          {footer}
        </div>
        {aside}
      </div>
    </div>
  );
}

export function ChannelWallpaper({ className = "" }: { className?: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 ${className}`}
      style={{
        opacity: "var(--wallpaper-opacity)",
        backgroundImage:
          process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1"
            ? `url("/studio/chat-wallpaper-${resolvedTheme}.png")`
            : "var(--wallpaper-image)",
        backgroundRepeat: "repeat",
        backgroundSize: "320px auto"
      }}
    />
  );
}
