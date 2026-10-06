"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentChatProgress } from "@/lib/agent-chat-progress";

export function AgentThinkingIndicator({
  progress
}: {
  progress: AgentChatProgress;
}) {
  return (
    <ThinkingIndicator
      key={`${progress.key}:${progress.state === "completed" ? "history" : "live"}`}
      progress={progress}
    />
  );
}
function ThinkingIndicator({ progress }: { progress: AgentChatProgress }) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const animated = ["sending", "queued", "working", "responding"].includes(
    progress.state
  );
  useEffect(() => {
    if (!animated) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden")
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [animated, startedAt]);
  return (
    <div
      className="py-2 text-[11px] font-normal text-faint"
      data-agent-progress={progress.state}
    >
      {progress.state !== "completed" && (
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${animated ? "bg-accent/70 motion-safe:animate-pulse" : "bg-subtle/60"}`}
          />
          <span
            className="min-w-0 break-words"
            role="status"
            aria-live="polite"
          >
            {progress.label}
          </span>
          {animated && elapsed >= 3 && (
            <span
              aria-hidden="true"
              className="shrink-0 text-[10px] tabular-nums text-faint"
            >
              {elapsed < 60
                ? `${elapsed}s`
                : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
            </span>
          )}
        </div>
      )}
      {progress.steps.length > 0 && (
        <details
          className="group ml-4 mt-1"
          open={progress.state !== "completed" ? true : undefined}
        >
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[11px] text-faint transition-colors hover:text-muted [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="h-3 w-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            />
            {progress.state === "completed"
              ? `Agent activity · ${progress.steps.length} updates`
              : "Agent activity"}
          </summary>
          <ol className="mt-2 max-h-48 space-y-2 overflow-y-auto border-l border-border/60 pl-3">
            {progress.steps.map((step) => (
              <li key={step.id}>
                <p className="text-[11px] text-faint">{step.title}</p>
                {step.detail && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-faint">
                    {step.detail}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
