import { useEffect, useState } from "react";
import { Badge, Button } from "@koed/ui";
import { Folder, GitFork } from "lucide-react";
import type { PersonalSourceContextState } from "@koed/shared";
import {
  personalInventoryConversationKey,
  type PersonalDesktopApi,
  type PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { effective } from "../../views/personal/SourceContextCompare.js";
import { sourceLabel } from "./source-label.js";
import {
  projectErrorMessage,
  type ConversationManagementTarget
} from "./use-organization-review.js";

export function ConversationTags({
  api,
  projects,
  thread,
  sourceProjectId,
  revision,
  busy,
  onProject,
  onContext
}: {
  api: PersonalDesktopApi;
  projects: readonly DesktopProject[];
  thread: PersonalDesktopProjectThread;
  sourceProjectId?: string;
  revision: number;
  busy?: boolean;
  onProject: (id: string) => void;
  onContext: (
    target: ConversationManagementTarget,
    axis: "git" | "folder"
  ) => void;
}) {
  const [context, setContext] = useState<PersonalSourceContextState>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const sessionId = thread.sessionId;
  useEffect(() => {
    if (!sessionId || !api.manageSourceContext) return;
    let current = true;
    setError("");
    void api
      .manageSourceContext({ action: "get", sessionId })
      .then((result) => {
        if (current && result.context.sessionId === sessionId)
          setContext(result.context);
      })
      .catch((cause) => {
        if (current) setError(projectErrorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [api, sessionId, revision, retry]);
  if (!sessionId) return null;
  const target = {
    sessionId,
    title: thread.name,
    sourceProjectId,
    deviceName: thread.originDevice?.name
  };
  const memberships = projects.filter(
    (p) =>
      p.namedProject &&
      p.threads.some(
        (t) =>
          personalInventoryConversationKey(t) ===
          personalInventoryConversationKey(thread)
      )
  );
  const source = context?.sessionId === sessionId ? context : undefined;
  const git = source ? effective(source.git) : undefined;
  const folder = source ? effective(source.folder) : undefined;
  const gitName =
    git?.state === "known" ? (git.value.anchorDisplay ?? git.value.key) : null;
  const folderDescription =
    folder?.state === "known" ? sourceLabel(folder, projects) : null;
  const folderName =
    folder?.state === "known"
      ? (folder.value.normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) ??
        folder.value.normalizedPath)
      : null;
  const emptyLabel = (axis: "git" | "folder") =>
    source?.sync?.[axis].state === "conflict"
      ? "Review conflict"
      : source?.sync?.[axis].state === "pending"
        ? "Pending"
        : "Add";
  return (
    <div className="v1-project-ui v1-pm-tags" aria-label="Conversation tags">
      {memberships.map((p) => (
        <button
          type="button"
          key={p.id}
          onClick={() => onProject(p.id)}
          disabled={busy}
          title={`Project: ${p.name}`}
        >
          <Badge variant="outline">
            <Folder />
            <span>Project</span>
            {p.name}
          </Badge>
        </button>
      ))}
      {source && (
        <>
          <button
            type="button"
            onClick={() => onContext(target, "git")}
            disabled={busy}
            title={gitName ?? "Assign Git Anchor"}
          >
            <Badge variant="outline">
              <GitFork />
              <span>Git</span>
              {gitName ?? emptyLabel("git")}
            </Badge>
          </button>
          <button
            type="button"
            onClick={() => onContext(target, "folder")}
            disabled={busy}
            title={folderDescription ?? "Assign Folder"}
          >
            <Badge variant="outline">
              <Folder />
              <span>Folder</span>
              {folderName ?? emptyLabel("folder")}
            </Badge>
          </button>
        </>
      )}
      {error && (
        <Button
          variant="ghost"
          size="xs"
          title={error}
          onClick={() => setRetry((v) => v + 1)}
        >
          Retry source tags
        </Button>
      )}
    </div>
  );
}
