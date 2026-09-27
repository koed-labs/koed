"use client";

import { useSyncExternalStore } from "react";
import { ChevronRight } from "lucide-react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readCollapsed(key: string, fallback: boolean) {
  try {
    return window.localStorage.getItem(key) === null
      ? fallback
      : window.localStorage.getItem(key) === "1";
  } catch {
    return fallback;
  }
}

export function CollapsibleSection({
  id,
  title,
  count,
  action,
  defaultCollapsed = false,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  action?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const key = `koed.collapsed.${id}`;
  const collapsed = useSyncExternalStore(
    subscribe,
    () => readCollapsed(key, defaultCollapsed),
    () => defaultCollapsed,
  );
  const setCollapsed = (next: boolean) => {
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // This preference is optional; the section remains interactive.
    }
    listeners.forEach((listener) => listener());
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} className="group flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-left">
          <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 text-subtle transition-transform ${collapsed ? "" : "rotate-90"}`} />
          <span className="text-sm font-medium text-foreground">{title}</span>
          {count !== undefined && count > 0 && <span className="rounded-full px-1.5 text-[11px] font-medium text-faint">{count}</span>}
        </button>
        {!collapsed && action}
      </div>
      {!collapsed && children}
    </section>
  );
}
