import { FileDiff } from "@pierre/diffs/react";
import { useMemo, useState } from "react";

import { parseSourcePatch, type SourcePatchDetails } from "./source-diff.js";

export type SourceDiffProps = {
  className?: string;
  details?: SourcePatchDetails;
  sourceText: string;
};

export function SourceDiff({
  className,
  details,
  sourceText
}: SourceDiffProps) {
  const parsed = useMemo(
    () => details ?? parseSourcePatch(sourceText),
    [details, sourceText]
  );
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const useWorkerPool =
    typeof window !== "undefined" && typeof Worker !== "undefined";

  if (!parsed?.supported || !parsed.fileDiffs.length) {
    return (
      <section
        aria-label="Raw source change"
        className={["memory-source-diff-fallback", className]
          .filter(Boolean)
          .join(" ")}
      >
        <p role="status">
          {parsed?.parseError
            ? "This source change could not be parsed. Showing the original text."
            : "This source change is available as original text."}
        </p>
        <pre>{parsed?.sourceText ?? sourceText}</pre>
      </section>
    );
  }

  return (
    <section
      aria-label={parsed.summary}
      className={["memory-source-diff", className].filter(Boolean).join(" ")}
    >
      <p className="memory-source-diff-summary">
        <strong>
          {parsed.files.length} {parsed.files.length === 1 ? "file" : "files"}{" "}
          changed
        </strong>
        <span className="memory-source-diff-additions">
          +{parsed.additions}
        </span>
        <span className="memory-source-diff-deletions">
          −{parsed.deletions}
        </span>
      </p>
      <div className="memory-source-diff-files">
        {parsed.fileDiffs.map((fileDiff, index) => {
          const expanded = expandedIndex === index;
          const name =
            fileDiff.name.split("/").filter(Boolean).at(-1) ?? fileDiff.name;
          return (
            <div
              className="memory-source-diff-file"
              key={`${fileDiff.name}-${index}`}
            >
              <FileDiff
                disableWorkerPool={!useWorkerPool}
                fileDiff={fileDiff}
                options={{
                  collapsed: !expanded,
                  diffStyle: "unified",
                  theme: {
                    light: "pierre-light-soft",
                    dark: "pierre-dark-soft"
                  }
                }}
                renderHeaderPrefix={() => (
                  <button
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} file diff for ${name}`}
                    className="memory-source-diff-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedIndex(expanded ? null : index);
                    }}
                    type="button"
                  >
                    <span aria-hidden="true">›</span>
                  </button>
                )}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
