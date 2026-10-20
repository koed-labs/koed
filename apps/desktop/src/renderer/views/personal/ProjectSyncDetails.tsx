import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@koed/ui";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";

type Manage = NonNullable<PersonalDesktopApi["manageMembershipSync"]>;
type Result = Awaited<ReturnType<Manage>>;
type Entity = NonNullable<Result["state"]["catalog"]>;
type Change = Extract<
  Parameters<Manage>[0],
  { action: "preview" }
>["review"]["change"];
const operationLabel = (revision: Entity["heads"][number]) => {
  const operation = revision.operation;
  if (operation.kind === "set_project") return `Name: ${operation.name}`;
  if (operation.kind === "delete_project") return "Delete Project";
  if (operation.kind === "include") {
    const target = operation.selector;
    return target.kind === "repository"
      ? `Include Git Anchor: ${target.repository.anchorDisplay}`
      : target.kind === "folder"
        ? `Include Folder on device ${target.folder.originatingDeviceId}, profile ${target.folder.originatingProfileId}`
        : "Include Conversation";
  }
  if (operation.kind === "exclude") return "Exclude Conversation";
  if (operation.kind === "clear_exclusion") return "Clear exclusion";
  if (operation.kind === "remove_inclusion") return "Remove inclusion";
  return "Membership change";
};
export function ProjectSyncDetails({
  project,
  projects = [],
  manage,
  store,
  onDeleted,
  open: controlledOpen,
  onOpenChange,
  returnFocus
}: {
  project: DesktopProject;
  projects?: readonly DesktopProject[];
  manage: Manage;
  store: PersonalMemoryStore;
  onDeleted: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const [localOpen, setLocalOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [state, setState] = useState<Result["state"] | null>(null),
    [preview, setPreview] = useState<Result["preview"]>();
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const projectId = project.namedProject?.projectId;
  const load = useCallback(
    async (afterEntityId?: string) => {
      if (!projectId) return;
      setBusy(true);
      setError("");
      setPreview(undefined);
      try {
        const result = await manage({
          action: "list",
          projectId,
          afterEntityId
        });
        setState((previous) =>
          afterEntityId && previous
            ? {
                ...result.state,
                memberships: [
                  ...previous.memberships,
                  ...result.state.memberships
                ]
              }
            : result.state
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [manage, projectId]
  );
  useEffect(() => {
    if (controlledOpen) {
      setState(null);
      void load();
    }
  }, [controlledOpen, load]);
  if (!project.namedProject || !projectId) return null;
  const review = async (entity: Entity, change: Change) => {
    if (!state) return;
    setBusy(true);
    setError("");
    setPreview(undefined);
    try {
      const result = await manage({
        action: "preview",
        projectId,
        review: {
          entityId: entity.entityId,
          expectedVersion: state.project.version,
          expectedHeads: entity.heads.map((head) => head.revisionId),
          change
        }
      });
      setState(result.state);
      setPreview(result.preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await manage({
        action: "apply",
        projectId,
        reviewId: preview.reviewId,
        expectedVersion: preview.expectedVersion
      });
      setState(result.state);
      setPreview(undefined);
      await store.loadProjects({ silent: true });
      if (result.state.project.deletedAt) {
        setOpen(false);
        onDeleted();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  };
  const catalogReady =
    state?.catalog?.state === "available" &&
    state.catalog.heads[0]?.operation.kind === "set_project";
  const entityDetails = (entity: Entity) => {
    const source = entity.source;
    const title = source?.localSessionId
      ? ([project, ...projects]
          .flatMap((value) => value.threads)
          .find((thread) => thread.sessionId === source.localSessionId)?.name ??
        "Conversation")
      : source
        ? "Conversation awaiting source"
        : entity.entityKind === "rule"
          ? "Inclusion rule"
          : "Project catalog";
    return (
      <section
        className="personal-project-sync-entity"
        key={entity.entityId}
        aria-label={title}
      >
        <h3>{title}</h3>
        {entity.state === "conflict" ? (
          <p role="status">
            These changes conflict. Review a choice before applying it.
          </p>
        ) : null}
        {entity.state === "pending" ? (
          <p>Waiting for complete membership history.</p>
        ) : null}
        {source && !source.ready ? (
          <p>
            The source has not arrived. This reference adds no Memory until its
            verified source is available.
          </p>
        ) : null}
        {source ? (
          <details>
            <summary>Source reference</summary>
            <p>Origin device: {source.reference.originatingDeviceId}</p>
            <p>{source.reference.logicalSessionId}</p>
          </details>
        ) : null}
        <ul>
          {entity.heads.map((head) => (
            <li key={head.revisionId}>
              <span>{operationLabel(head)}</span>
              {entity.state === "conflict" &&
              entity.entityKind === "project" &&
              (head.operation.kind === "set_project" ||
                head.operation.kind === "delete_project") ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void review(
                      entity,
                      head.operation.kind === "set_project"
                        ? { kind: "set_project", name: head.operation.name }
                        : { kind: "delete_project" }
                    )
                  }
                >
                  Review this choice
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {entity.entityKind === "rule" && entity.state !== "pending" ? (
          <div className="personal-project-sync-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void review(entity, { kind: "remove_inclusion" })}
            >
              Review rule removal
            </Button>
            {(entity.ruleCandidates ?? []).map((candidate) => (
              <Button
                key={candidate.revisionId}
                variant="outline"
                size="sm"
                disabled={busy || !catalogReady}
                onClick={() =>
                  void review(entity, {
                    kind: "include",
                    candidateRevisionId: candidate.revisionId
                  })
                }
              >
                Review {operationLabel(candidate)}
              </Button>
            ))}
          </div>
        ) : null}
        {entity.entityKind === "exclusion" && entity.state !== "pending" ? (
          <div className="personal-project-sync-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void review(entity, { kind: "exclude" })}
            >
              Review exclusion
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void review(entity, { kind: "clear_exclusion" })}
            >
              Review clearing exclusion
            </Button>
          </div>
        ) : null}
        {entity.entityKind === "direct" && entity.state !== "pending" ? (
          <div className="personal-project-sync-actions">
            {entity.state === "conflict" ||
            entity.heads[0]?.operation.kind === "include" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void review(entity, { kind: "remove_inclusion" })
                }
              >
                Review removal
              </Button>
            ) : null}
            {entity.state === "conflict" ||
            entity.heads[0]?.operation.kind === "remove_inclusion" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !catalogReady}
                onClick={() => void review(entity, { kind: "include" })}
              >
                Review inclusion
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          if (!value) setPreview(undefined);
        }
      }}
    >
      {controlledOpen === undefined ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setState(null);
            setOpen(true);
            void load();
          }}
        >
          Sync details
        </Button>
      ) : null}
      <DialogPopup finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Project sync details</DialogTitle>
          <DialogDescription>
            Review conflicting catalog, rule, and exclusion changes, and
            Conversations waiting for their source.
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert">{error}</p> : null}
        {busy ? <p role="status">Loading…</p> : null}
        {preview ? (
          <section aria-label="Membership review preview">
            <h3>Review change</h3>
            <p>{operationLabel(preview.after)}</p>
            <p>
              {preview.after.operation.kind === "delete_project"
                ? "The Project will be deleted. Its retained history remains available for sync."
                : preview.after.operation.kind === "set_project"
                  ? "This name will replace all reviewed conflicting catalog revisions."
                  : preview.after.operation.kind === "exclude"
                    ? "This exclusion will block the Conversation from every inclusion reason in this Project."
                    : preview.after.operation.kind === "clear_exclusion"
                      ? "This exclusion will be cleared. The Conversation still needs an inclusion reason and its verified source."
                      : preview.before.entityKind === "rule" &&
                          preview.after.operation.kind === "include"
                        ? "This rule will include matching verified sources, including sources that arrive later. Exclusions still apply."
                        : preview.effect.included
                          ? "This inclusion will make the available Conversation part of the Project."
                          : preview.after.operation.kind === "remove_inclusion"
                            ? "This inclusion will be removed. Other inclusion rules still apply."
                            : preview.effect.blockedByExclusion
                              ? "This direct inclusion will be retained. An exclusion still blocks this Conversation from the Project."
                              : "This inclusion will wait for its verified source."}
            </p>
            <p>
              Apply will fail if the Project or reviewed revisions change
              {preview.before.source
                ? ", or if this source’s availability changes"
                : ""}
              .
            </p>
          </section>
        ) : state ? (
          <div className="personal-project-sync-list">
            {state.catalog ? (
              entityDetails(state.catalog)
            ) : (
              <p>This Project has no synchronized history yet.</p>
            )}
            {state.memberships.map(entityDetails)}
            {state.nextEntityId ? (
              <Button
                disabled={busy}
                onClick={() => void load(state.nextEntityId!)}
              >
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            Reload
          </Button>
          {preview ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPreview(undefined)}
              >
                Back
              </Button>
              <Button disabled={busy} onClick={() => void apply()}>
                Apply reviewed change
              </Button>
            </>
          ) : null}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
