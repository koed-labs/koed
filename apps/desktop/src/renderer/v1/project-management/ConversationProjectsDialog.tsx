import { useState } from "react";
import { Button, Checkbox, DialogFooter } from "@koed-labs/ui";
import { Folder } from "lucide-react";
import { ProjectError, ProjectPopup } from "./controls.js";
import {
  excludedMembership,
  organizationEdit,
  unresolvedMembership
} from "./conversation-organization.js";
import {
  useOrganizationReview,
  type OrganizationDialogProps
} from "./use-organization-review.js";

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
  return (
    <ProjectPopup
      title="Project memberships"
      description={props.target.title}
      busy={busy}
      onClose={props.onClose}
    >
      {!review && !error && <p role="status">Loading…</p>}
      <div className="v1-pm-list v1-pm-scroll-list">
        {review?.memberships.map(({ project, explanation }) => {
          const excluded = excludedMembership(explanation),
            unresolved = unresolvedMembership(explanation);
          const changed = changes[project.id],
            checked = changed ?? explanation.included;
          return (
            <div className="v1-pm-choice-row" key={project.id}>
              <Checkbox
                aria-label={`Include in ${project.name}`}
                checked={checked}
                disabled={busy || unresolved || (excluded && changed !== true)}
                onCheckedChange={(value) =>
                  setChanges((prev) => ({ ...prev, [project.id]: value }))
                }
              />
              <Folder />
              <span className="v1-pm-row-copy">
                <b>{project.name}</b>
                {(unresolved || excluded) && (
                  <small>
                    {unresolved
                      ? "Review sync conflict"
                      : checked
                        ? "Will be restored"
                        : "Excluded"}
                  </small>
                )}
              </span>
              {excluded && !unresolved && !checked && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    setChanges((prev) => ({ ...prev, [project.id]: true }))
                  }
                >
                  Add back
                </Button>
              )}
            </div>
          );
        })}
      </div>
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
