"use client";

import { History } from "lucide-react";
import type { ManagedChatMemoryAttribution } from "@/lib/managed-agent-chat";

/** Compact, non-interactive attribution for a historical Assistant reply. */
export function MemoryAttributionNote({
  memory
}: {
  memory: ManagedChatMemoryAttribution;
}) {
  if (!memory.used && memory.status === "available") return null;

  return (
    <div className="mt-2 rounded-md border border-accent/25 bg-accent/[0.06] px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <History
          className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-accent"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-0.5">
          {memory.status === "skipped" ? (
            <p className="text-[11px] leading-snug text-foreground-secondary">
              Continued without Memory
            </p>
          ) : memory.status === "unavailable" ? (
            <p className="text-[11px] leading-snug text-foreground-secondary">
              Memory could not be checked
            </p>
          ) : null}
          {memory.used && memory.citations.length > 0 ? (
            memory.citations.map((citation, index) => (
              <p
                key={`${citation.label}-${index}`}
                className="text-[11px] leading-snug text-foreground-secondary"
              >
                {citation.label}
              </p>
            ))
          ) : memory.used ? (
            <p className="text-[11px] leading-snug text-foreground-secondary">
              From Memory
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
