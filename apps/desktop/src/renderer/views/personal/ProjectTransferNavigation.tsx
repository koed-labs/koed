import { ChevronRight } from "lucide-react";
import type { Ref } from "react";
import type { TransferSource } from "./project-transfer-model.js";

type Tab = "all" | "repository" | "folder";
export function ProjectTransferNavigation({
  label,
  tab,
  path,
  busy,
  all,
  navigationRef,
  onTab,
  onBrowse
}: {
  label: string;
  tab: Tab;
  path: TransferSource[];
  busy: boolean;
  all?: boolean;
  navigationRef?: Ref<HTMLElement>;
  onTab: (tab: Tab) => void;
  onBrowse: (path: TransferSource[]) => void;
}) {
  const name = (kind: Tab) =>
    kind === "all" ? "All" : kind === "repository" ? "Git Anchors" : "Folders";
  return (
    <nav
      className="personal-transfer-navigation"
      aria-label={label}
      ref={navigationRef}
    >
      {path.length ? (
        <>
          <button type="button" disabled={busy} onClick={() => onBrowse([])}>
            {name(tab)}
          </button>
          {path.map((entry, index) => (
            <span className="personal-transfer-crumb" key={entry.id}>
              <ChevronRight aria-hidden="true" />
              {index === path.length - 1 ? (
                <span aria-current="page">{entry.name}</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onBrowse(path.slice(0, index + 1))}
                >
                  {entry.name}
                </button>
              )}
            </span>
          ))}
        </>
      ) : (
        (all
          ? (["all", "repository", "folder"] as const)
          : (["repository", "folder"] as const)
        ).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={busy}
            aria-pressed={tab === kind}
            onClick={() => onTab(kind)}
          >
            {name(kind)}
          </button>
        ))
      )}
    </nav>
  );
}
