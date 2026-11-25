import { useState } from "react";
import { Button, DialogFooter } from "@koed-labs/ui";
import { ChevronRight, CircleAlert, Folder } from "lucide-react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { Pixelkin } from "../pixelkin/Pixelkin.js";
import { projectKinLook } from "../pixelkin/agent-kin.js";
import { ProjectChoice, ProjectError, ProjectPopup } from "./controls.js";
import {
  excludedMembership,
  moveConversationEdit,
  unresolvedMembership
} from "./conversation-organization.js";
import {
  projectErrorMessage,
  useOrganizationReview,
  type OrganizationDialogProps
} from "./use-organization-review.js";

const Kin = ({ project }: { project?: DesktopProject | undefined }) =>
  project?.namedProject ? (
    <Pixelkin
      look={projectKinLook(project.id, project.namedProject.kin)}
      size={32}
      className="v1-pm-row-kin"
      motion="still"
    />
  ) : (
    <Folder size={20} />
  );

export function MoveConversationDialog(
  props: OrganizationDialogProps & { destinationId?: string }
) {
  const { review, error, setError, busy, apply } = useOrganizationReview(props);
  const [destination, setDestination] = useState(
    props.destinationId ??
      props.projects.find(
        (p) => p.namedProject && p.id !== props.target.sourceProjectId
      )?.id ??
      ""
  );
  const source = review?.projects.find(
    (p) => p.id === props.target.sourceProjectId
  );
  const target = review?.memberships.find((p) => p.project.id === destination);
  const restore = !!target && excludedMembership(target.explanation);
  const blocked = !!target && unresolvedMembership(target.explanation);
  return (
    <ProjectPopup
      title="Move Conversation"
      description={props.target.title}
      busy={busy}
      onClose={props.onClose}
    >
      {!review && !error && <p role="status">Loading…</p>}
      {review && (
        <div className="v1-pm-form-stack">
          <div className="v1-pm-move-path">
            <Kin project={source} />
            <span>{source?.name ?? "Without a Project"}</span>
            <ChevronRight size={18} />
            {target && <Kin project={target.project} />}
            <span>{target?.project.name ?? "Select a Project"}</span>
          </div>
          <div className="v1-pm-field">
            <span>Destination Project</span>
            <ProjectChoice
              label="Destination Project"
              value={destination}
              options={review.projects
                .filter((p) => p.id !== source?.id)
                .map((p) => ({
                  value: p.id,
                  label: p.name,
                  look: projectKinLook(p.id, p.namedProject?.kin)
                }))}
              onChange={setDestination}
              disabled={busy}
            />
          </div>
          {(restore || blocked) && (
            <div className="v1-pm-status">
              <CircleAlert className="v1-pm-status-warning" />
              {blocked
                ? "Review the Project’s sync conflict first"
                : "Previously excluded"}
            </div>
          )}
        </div>
      )}
      <ProjectError error={error} />
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          disabled={!review || !target || blocked || busy}
          onClick={() => {
            if (!review) return;
            try {
              const edit = moveConversationEdit(
                review,
                props.target.sourceProjectId,
                destination,
                { restore }
              );
              if (edit) void apply(edit, destination);
              else props.onClose();
            } catch (cause) {
              setError(projectErrorMessage(cause));
            }
          }}
        >
          {busy ? "Moving…" : restore ? "Restore and move" : "Move"}
        </Button>
      </DialogFooter>
    </ProjectPopup>
  );
}
