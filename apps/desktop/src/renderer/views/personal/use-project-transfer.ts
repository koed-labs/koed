import { useRef, useState } from "react";
import { personalRecallTargetsEqual } from "@koed/shared/personal-desktop";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import type { TransferMutation } from "./project-transfer-model.js";

type Manage = NonNullable<PersonalDesktopApi["manageProject"]>;

/** Validate the complete draft at its reviewed version, then commit it atomically.
 * A conflict requires a new review. Never rebase or retry it against a new version. */
export function useProjectTransfer(
  project: DesktopProject,
  manage: Manage,
  store: PersonalMemoryStore
) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [failed, setFailed] = useState(false);

  const commit = async (
    commands: TransferMutation[],
    expectedVersion: number
  ) => {
    if (running.current || !commands.length || failed || !project.namedProject)
      return false;
    running.current = true;
    setBusy(true);
    setError("");
    setAnnouncement("");
    const version = expectedVersion;
    let confirmed = false;
    try {
      for (const command of commands) {
        if (
          command.action === "add_repository" ||
          command.action === "add_folder"
        ) {
          const target =
            command.action === "add_repository"
              ? { kind: "repository" as const, repository: command.repository }
              : { kind: "folder" as const, folder: command.folder };
          const review = await manage({
            ...(command.action === "add_repository"
              ? ({
                  action: "preview_repository",
                  repository: command.repository
                } as const)
              : ({
                  action: "preview_folder",
                  folder: command.folder
                } as const)),
            projectId: project.id,
            expectedVersion: version
          });
          if (
            review.project.projectId !== project.id ||
            review.project.version !== version ||
            !review.preview ||
            !personalRecallTargetsEqual(review.preview.target, target)
          )
            throw new Error(
              "The source changed. Reload the Project before including it."
            );
        } else if (
          command.action === "add_session" ||
          command.action === "exclude_session"
        ) {
          const review = await manage({
            action: "explain_session",
            projectId: project.id,
            expectedVersion: version,
            sessionId: command.sessionId
          });
          if (
            review.project.projectId !== project.id ||
            review.project.version !== version ||
            !review.explanation ||
            review.explanation.sessionId !== command.sessionId
          )
            throw new Error(
              "Conversation membership could not be verified. Reload the Project."
            );
          if (
            command.action === "exclude_session" &&
            !review.explanation.included
          )
            throw new Error(
              "This Conversation is no longer included. Close and reopen Project setup."
            );
          if (
            command.action === "add_session" &&
            (review.explanation.syncExclusion?.blocked ||
              (review.explanation.exclusion &&
                review.explanation.exclusion.clearedAt === null))
          )
            throw new Error(
              "This Conversation is excluded. Review its Project membership to add it back."
            );
        }
      }
      const result = await manage({
        action: "apply_sources",
        projectId: project.id,
        expectedVersion,
        changes: commands
      });
      if (
        result.project.projectId !== project.id ||
        result.project.version < expectedVersion
      )
        throw new Error(
          "The Project response could not be verified. Reload before continuing."
        );
      confirmed = true;
      const refreshed = await store.loadProjects({ silent: true });
      if (refreshed.error) throw new Error(refreshed.error);
      setAnnouncement(`${commands.length} changes saved.`);
      return true;
    } catch (cause) {
      setFailed(true);
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        `${confirmed ? "Changes were saved. " : ""}${message} Close and reopen Sources before making further changes.`
      );
      await store.loadProjects({ silent: true });
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return { busy, error, announcement, failed, commit };
}
