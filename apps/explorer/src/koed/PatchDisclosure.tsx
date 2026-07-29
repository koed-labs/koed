import { FileDiff } from "@pierre/diffs/react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, cn } from "@koed/ui";
import { useTheme } from "../hooks/useTheme";
import { type PatchDetails } from "./diff";

export function PatchBody({
  patch,
  className
}: {
  patch: PatchDetails;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const useWorkerPool =
    typeof window !== "undefined" && typeof Worker !== "undefined";
  const files = useMemo(() => patch.fileDiffs ?? [], [patch.fileDiffs]);

  if (
    !patch.supported ||
    patch.normalizedText.trim().length === 0 ||
    files.length === 0
  ) {
    return (
      <div
        className={cn(
          "overflow-hidden rounded-md border border-border bg-background/70",
          className
        )}
      >
        <pre
          className={cn(
            "max-h-[28rem] overflow-auto whitespace-pre-wrap bg-secondary/35 p-2.5 font-mono text-[12px] leading-relaxed text-foreground",
            resolvedTheme === "dark" && "bg-secondary/40"
          )}
        >
          {patch.sourceText}
        </pre>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {files.map((fileDiff, index) => {
        const isExpanded = expandedIndex === index;
        const displayName =
          fileDiff.name.split("/").filter(Boolean).at(-1) ?? fileDiff.name;

        return (
          <div
            className="overflow-hidden rounded-md border border-border bg-background/70"
            key={`${fileDiff.name}-${index}`}
          >
            <FileDiff
              className="koed-patch-diff"
              disableWorkerPool={!useWorkerPool}
              fileDiff={fileDiff}
              options={{
                collapsed: !isExpanded,
                diffStyle: "unified",
                theme: {
                  light: "pierre-light-soft",
                  dark: "pierre-dark-soft"
                }
              }}
              renderHeaderPrefix={() => (
                <Button
                  aria-expanded={isExpanded}
                  aria-label={
                    isExpanded
                      ? `Collapse file diff for ${displayName}`
                      : `Expand file diff for ${displayName}`
                  }
                  className="mr-1 size-6 shrink-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpandedIndex(isExpanded ? null : index);
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )}
                </Button>
              )}
            />
          </div>
        );
      })}
    </div>
  );
}
