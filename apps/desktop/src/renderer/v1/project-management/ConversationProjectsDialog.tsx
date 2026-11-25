import { useState } from "react";
import { Button, DialogFooter } from "@koed-labs/ui";
import { Folder } from "lucide-react";
import type { PersonalProjectMembershipExplanation } from "@koed-labs/shared";
import { Pixelkin } from "../pixelkin/Pixelkin.js";
import { projectKinLook } from "../pixelkin/agent-kin.js";
import { ProjectError, ProjectPopup } from "./controls.js";
import { Row } from "./ConversationsPanel.js";
import {
  directMembership,
  excludedMembership,
  organizationEdit,
  unresolvedMembership
} from "./conversation-organization.js";
import {
  useOrganizationReview,
  type OrganizationDialogProps
} from "./use-organization-review.js";

/** How a Conversation is in a Project, in the words Project settings uses. */
export function membershipDetail(
  explanation: PersonalProjectMembershipExplanation
): string {
  if (unresolvedMembership(explanation)) return "Review sync conflict";
  if (excludedMembership(explanation)) return "Excluded by you";
  if (!explanation.included) return "Not in this Project";
  const kinds = new Set(explanation.reasons.map((r) => r.kind));
  return [
    ...(kinds.has("repository") ? ["Git Anchor"] : []),
    ...(kinds.has("folder") ? ["Folder"] : []),
    ...(kinds.has("session") ? ["Added directly"] : [])
  ].join(" · ");
}

export function ConversationProjectsDialog(props: OrganizationDialogProps) {
  const { review, error, busy, apply } = useOrganizationReview(props);
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const save = async () => {
    if (!review) return;
    const memberships = review.memberships.flatMap(
      ({ project, explanation }) => {
        const checked = changes[project.id];
        if (checked === undefined || checked === explanation.included)
          return [];
        const exclusion = explanation.exclusion;
        return [
          {
            projectId: project.id,
            direct: checked,
            excluded:
              !checked && explanation.reasons.some((r) => r.kind !== "session"),
            ...(checked && excludedMembership(explanation) && exclusion
              ? {
                  restoreExclusion: {
                    exclusionId: exclusion.exclusionId,
                    expectedExclusionRevisionId: exclusion.headRevisionId
                  }
                }
              : {})
          }
        ];
      }
    );
    if (!memberships.length) {
      props.onClose();
      return;
    }
    await apply(organizationEdit(review, memberships));
  };
  // Split by saved state, so a staged row stays where it is.
  const members = (review?.memberships ?? []).filter(
    (m) => m.explanation.included
  );
  const others = (review?.memberships ?? []).filter(
    (m) => !m.explanation.included
  );
  return (
    <ProjectPopup
      title="Project memberships"
      description={props.target.title}
      busy={busy}
      onClose={props.onClose}
    >
      {!review && !error && <p role="status">Loading…</p>}
      {review && review.projects.length > 0 && (
        <div className="v1-pm-scroll-list v1-pm-membership-sections">
          {(
            [
              [
                "in",
                members.length === 1
                  ? "In 1 Project"
                  : `In ${members.length} Projects`,
                members
              ],
              ["out", "Other Projects", others]
            ] as const
          ).map(
            ([key, heading, rows]) =>
              rows.length > 0 && (
                <section key={key} aria-label={heading}>
                  <h3 className="v1-pm-membership-heading">{heading}</h3>
                  <div className="v1-pm-list v1-pm-conversation-list">
                    {rows.map(({ project, explanation }) => {
                      const excluded = excludedMembership(explanation),
                        unresolved = unresolvedMembership(explanation);
                      const changed = changes[project.id];
                      const pending =
                        changed === undefined ||
                        changed === explanation.included
                          ? undefined
                          : changed
                            ? excluded
                              ? "Will be added back"
                              : "Will be added"
                            : explanation.reasons.some(
                                  (r) => r.kind !== "session"
                                )
                              ? "Will be excluded"
                              : "Will be removed";
                      const action = unresolved
                        ? undefined
                        : explanation.included
                          ? "Remove"
                          : excluded
                            ? "Add back"
                            : "Add";
                      const detail = membershipDetail(explanation);
                      return (
                        <Row
                          key={project.id}
                          title={project.name}
                          className={
                            explanation.included ? undefined : "is-outside"
                          }
                          mark={
                            <Pixelkin
                              look={projectKinLook(
                                project.id,
                                project.namedProject?.kin,
                                project.kinItems
                              )}
                              size={24}
                              className="v1-pm-row-kin"
                              motion="still"
                            />
                          }
                          // The section already says it is not in the Project.
                          detail={
                            detail === "Not in this Project" ? "" : detail
                          }
                          menuSlot={false}
                          locked={directMembership(explanation)}
                          pending={pending}
                          action={action}
                          busy={busy}
                          onAction={() =>
                            setChanges((prev) => ({
                              ...prev,
                              [project.id]: !explanation.included
                            }))
                          }
                          onUndo={() =>
                            setChanges((prev) => {
                              const next = { ...prev };
                              delete next[project.id];
                              return next;
                            })
                          }
                        />
                      );
                    })}
                  </div>
                </section>
              )
          )}
        </div>
      )}
      {review && !review.projects.length && (
        <div className="v1-pm-empty">
          <Folder />
          No Projects yet
        </div>
      )}
      <ProjectError error={error} />
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          disabled={
            !review ||
            busy ||
            !review.memberships.some(
              (m) =>
                changes[m.project.id] !== undefined &&
                changes[m.project.id] !== m.explanation.included
            )
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </ProjectPopup>
  );
}
