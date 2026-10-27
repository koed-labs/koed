import { personalFolderScopeId } from "@koed/shared/personal-desktop";
import {
  filterProjectSourceConversations,
  systemConversationViews,
  type ProjectSourceFilter,
  type ProjectSourceInventory
} from "../../../project-source-navigation.js";

const selected = (
  filter: ProjectSourceFilter | undefined,
  candidate: ProjectSourceFilter
) =>
  Boolean(
    filter &&
    (filter.kind === "direct"
      ? candidate.kind === "direct"
      : filter.kind === "git"
        ? candidate.kind === "git" && filter.key === candidate.key
        : candidate.kind === "folder" &&
          filter.key === candidate.key &&
          filter.gitKey === candidate.gitKey)
  );

export function SourceBrowser({
  inventory,
  selectedProjectId,
  selectedFilter,
  onProjects,
  onSelect,
  loading,
  error,
  onRetry
}: {
  inventory: ProjectSourceInventory;
  selectedProjectId: string | null;
  selectedFilter?: ProjectSourceFilter;
  onProjects: () => void;
  onSelect: (projectId: string, filter?: ProjectSourceFilter) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const systems = systemConversationViews(inventory);
  const labels: Record<string, string> = {
    available: "Without a Project",
    independent: "Independent Conversations",
    unresolved: "Unresolved history"
  };
  return (
    <aside
      className="personal-projects-pane personal-source-browser"
      aria-label="Browse by source"
    >
      <header>
        <h1 data-personal-route-focus="projects" tabIndex={-1}>
          Sources
        </h1>
        <button type="button" onClick={onProjects}>
          Projects
        </button>
      </header>
      {loading ? <p role="status">Loading sources…</p> : null}
      {inventory.reconciliationPending ? (
        <p role="status">Project organization is pending.</p>
      ) : null}
      {error ? (
        <p role="alert">
          Sources unavailable.{" "}
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      {!loading &&
      !error &&
      !inventory.gitSources.length &&
      !inventory.folders.length &&
      !inventory.unresolved.length ? (
        <p role="status">No recorded sources yet.</p>
      ) : null}
      <nav aria-label="Independent sources" className="personal-project-list">
        <h2>Git Anchors</h2>
        {inventory.gitSources.map((source) => (
          <div key={source.id}>
            <button
              type="button"
              aria-current={
                selectedProjectId === source.id ? "page" : undefined
              }
              onClick={() => onSelect(source.id)}
            >
              {source.repository?.anchorDisplay ?? source.name} ·{" "}
              {source.threads.length}
            </button>
            <details>
              <summary>Checkout Folders</summary>
              {inventory.folders.flatMap((folder) => {
                if (!folder.folder) return [];
                const filter: ProjectSourceFilter = {
                  kind: "folder",
                  key: personalFolderScopeId(folder.folder.reference),
                  gitKey: source.id
                };
                const count = filterProjectSourceConversations(
                  source,
                  filter,
                  inventory
                ).length;
                return count
                  ? [
                      <button
                        key={folder.id}
                        type="button"
                        aria-pressed={selected(selectedFilter, filter)}
                        onClick={() => onSelect(source.id, filter)}
                      >
                        {folder.folder.normalizedPath} · Device{" "}
                        {folder.folder.reference.originatingDeviceId.slice(
                          0,
                          12
                        )}{" "}
                        · {count}
                      </button>
                    ]
                  : [];
              })}
            </details>
          </div>
        ))}
        <h2>Exact Folders</h2>
        {inventory.folders.map((folder) => (
          <button
            type="button"
            key={folder.id}
            aria-current={selectedProjectId === folder.id ? "page" : undefined}
            onClick={() => onSelect(folder.id)}
          >
            {folder.folder?.normalizedPath ?? folder.name}
            <small>
              Device {folder.folder?.reference.originatingDeviceId.slice(0, 12)}{" "}
              · Directory{" "}
              {folder.folder?.reference.directoryIncarnationId.slice(0, 8)} ·{" "}
              {folder.threads.length} Conversations
            </small>
          </button>
        ))}
        <h2>Conversations</h2>
        {Object.entries(systems).map(([kind, threads]) => (
          <button
            type="button"
            key={kind}
            aria-current={
              selectedProjectId === `system:${kind}` ? "page" : undefined
            }
            onClick={() => onSelect(`system:${kind}`)}
          >
            {labels[kind]} · {threads.length}
          </button>
        ))}
      </nav>
    </aside>
  );
}
