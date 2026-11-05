import { useEffect, useState } from "react";
import { Badge, Button, Checkbox, DialogFooter } from "@koed/ui";
import { ChevronRight, CircleAlert, Folder, GitFork } from "lucide-react";
import {
  effective,
  type SourceContextFact
} from "../../views/personal/SourceContextCompare.js";
import { ProjectChoice, ProjectError, ProjectPopup } from "./controls.js";
import {
  excludedMembership,
  moveConversationEdit,
  unresolvedMembership
} from "./conversation-organization.js";
import {
  reviewSourceCorrections,
  type CorrectionReview
} from "./correction-review.js";
import {
  projectErrorMessage,
  useOrganizationReview,
  type OrganizationDialogProps
} from "./use-organization-review.js";
import { sourceLabel } from "./source-label.js";

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
  const [keep, setKeep] = useState({ git: true, folder: true });
  const [impact, setImpact] = useState<CorrectionReview>();
  const [reviewing, setReviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const source = review?.projects.find(
    (p) => p.id === props.target.sourceProjectId
  );
  const target = review?.memberships.find((p) => p.project.id === destination);
  const restore = !!target && excludedMembership(target.explanation);
  const blocked = !!target && unresolvedMembership(target.explanation);
  useEffect(() => {
    setImpact(undefined);
    setPreviewError("");
    if (!review) return;
    const corrections = (["git", "folder"] as const)
      .filter((axis) => !keep[axis])
      .map((axis) => ({
        axis,
        action: "unresolved" as const,
        expectedVersion: review.context[axis].revision
      }));
    if (!corrections.length) {
      setReviewing(false);
      return;
    }
    let current = true;
    setReviewing(true);
    void reviewSourceCorrections(props.api, review, corrections)
      .then((result) => {
        if (current) setImpact(result);
      })
      .catch((cause) => {
        if (current) setPreviewError(projectErrorMessage(cause));
      })
      .finally(() => {
        if (current) setReviewing(false);
      });
    return () => {
      current = false;
    };
  }, [props.api, review, keep]);
  const lost =
    impact?.projects.filter(
      (p) => p.before && !p.after && p.id !== source?.id && p.id !== destination
    ) ?? [];
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
            <Folder size={14} />
            <span>{source?.name ?? "Without a Project"}</span>
            <ChevronRight size={14} />
            <span>{target?.project.name ?? "Select a Project"}</span>
          </div>
          <div className="v1-pm-field">
            <span>Destination Project</span>
            <ProjectChoice
              label="Destination Project"
              value={destination}
              options={review.projects
                .filter((p) => p.id !== source?.id)
                .map((p) => ({ value: p.id, label: p.name }))}
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
          <fieldset className="v1-pm-move-tags" disabled={busy}>
            <legend>Keep source tags</legend>
            <div className="v1-pm-list">
              {(["folder", "git"] as const).map((axis) => {
                const fact = effective<SourceContextFact>(review.context[axis]);
                const label = axis === "folder" ? "Folder" : "Git Anchor";
                const Icon = axis === "folder" ? Folder : GitFork;
                return (
                  <label className="v1-pm-choice-row" key={axis}>
                    <Checkbox
                      aria-label={`Keep ${label} tag`}
                      checked={fact.state === "known" && keep[axis]}
                      disabled={busy || fact.state !== "known"}
                      onCheckedChange={(checked) =>
                        setKeep((prev) => ({ ...prev, [axis]: checked }))
                      }
                    />
                    <Icon />
                    <span className="v1-pm-row-copy">
                      <b>{label}</b>
                      <small>
                        {fact.state === "known"
                          ? sourceLabel(fact, props.projects)
                          : "None"}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {reviewing && <p role="status">Reviewing source changes…</p>}
          {lost.length > 0 && (
            <div className="v1-pm-impact">
              <span>Also leaves</span>
              {lost.map((p) => (
                <Badge variant="outline" key={p.id}>
                  {p.name}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
      <ProjectError error={error || previewError} />
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          disabled={
            !review || !target || blocked || busy || reviewing || !!previewError
          }
          onClick={() => {
            if (!review) return;
            try {
              const edit = moveConversationEdit(
                review,
                props.target.sourceProjectId,
                destination,
                { restore, removeGit: !keep.git, removeFolder: !keep.folder }
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
