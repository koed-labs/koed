import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  DialogFooter,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab
} from "@koed-labs/ui";
import { ProposalWhy } from "./ProposalWhy.js";
import { RefreshCw, Trash2 } from "lucide-react";
import type { PersonalSourceCorrectionInput } from "@koed-labs/shared";
import {
  effective,
  SourceContextStatus,
  type SourceContextFact
} from "../../views/personal/SourceContextCompare.js";
import { projectTransferSources } from "../../views/personal/project-transfer-model.js";
import { ProjectChoice, ProjectError, ProjectPopup } from "./controls.js";
import { organizationEdit } from "./conversation-organization.js";
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
import {
  folderProposal,
  proposalProjectLabel,
  type FolderProposal
} from "./folder-hint-suggestion.js";
import { proposalResolvers } from "./proposal-resolvers.js";
import { repositoryTargetFor } from "./repository-project.js";
import {
  folderLabel,
  folderLabelText,
  folderSourceLabel
} from "./folder-label.js";
import { useFolderHint } from "./use-folder-hint.js";

const SUGGESTED_SOURCE = "suggested-source";

export function SourceContextDialog(
  props: OrganizationDialogProps & {
    axis?: "git" | "folder";
    scopeKey: string | null;
  }
) {
  const { review, error, setError, busy, apply } = useOrganizationReview(props);
  const [axis, setAxis] = useState(props.axis ?? "git");
  const [draft, setDraft] = useState({ git: "current", folder: "current" });
  const [preview, setPreview] = useState<CorrectionReview>();
  const [reviewing, setReviewing] = useState(false);
  const sources = useMemo(
    () => projectTransferSources(props.projects),
    [props.projects]
  );
  const folderUnresolved =
    !!review &&
    effective<SourceContextFact>(review.context.folder).state !== "known";
  const gitUnresolved =
    !!review &&
    effective<SourceContextFact>(review.context.git).state !== "known";
  const hints = useFolderHint(
    props.api,
    props.target.sessionId,
    props.scopeKey,
    folderUnresolved || gitUnresolved
  );
  const proposal = folderProposal(
    hints.filter((hint) =>
      hint.kind === "repository"
        ? gitUnresolved
        : folderUnresolved && !!props.api.confirmFolderHint
    ),
    proposalResolvers(props.projects)
  );
  const anchorName =
    proposal?.kind === "repository"
      ? repositoryTargetFor(props.projects, proposal.repositoryKey)?.repository
          .anchorDisplay
      : undefined;
  const [accepted, setAccepted] = useState<FolderProposal>();
  const acceptedAnchor =
    accepted?.kind === "repository"
      ? repositoryTargetFor(props.projects, accepted.repositoryKey)?.repository
      : undefined;
  const [confirming, setConfirming] = useState(false);
  const acceptProposal = async (candidate: FolderProposal) => {
    const tab = candidate.kind === "repository" ? "git" : "folder";
    setConfirming(true);
    setError("");
    try {
      if (candidate.kind !== "repository")
        await props.api.confirmFolderHint!({
          sessionId: props.target.sessionId,
          kind: candidate.kind,
          folder: candidate.folder
        });
      setAccepted(candidate);
      update(tab, SUGGESTED_SOURCE);
      setAxis(tab);
    } catch (cause) {
      setError(projectErrorMessage(cause));
    } finally {
      setConfirming(false);
    }
  };
  const update = (tab: "git" | "folder", value: string) => {
    setDraft((old) => ({ ...old, [tab]: value }));
    setPreview(undefined);
  };
  const corrections = (): PersonalSourceCorrectionInput[] => {
    if (!review) return [];
    return (["git", "folder"] as const).flatMap(
      (tab): PersonalSourceCorrectionInput[] => {
        const value = draft[tab],
          expectedVersion = review.context[tab].revision;
        if (value === "current") return [];
        if (value === "reset" || value === "unresolved")
          return [{ axis: tab, action: value, expectedVersion }];
        if (value === SUGGESTED_SOURCE && accepted) {
          if (tab === "folder" && accepted.kind !== "repository")
            return [
              {
                axis: tab,
                action: "set",
                folder: accepted.folder,
                expectedVersion
              }
            ];
          if (tab === "git" && acceptedAnchor)
            return [
              {
                axis: tab,
                action: "set",
                repository: acceptedAnchor,
                expectedVersion
              }
            ];
          throw new Error("The selected source is no longer available.");
        }
        const source = [...sources.repositories, ...sources.folders].find(
          (s) => s.id === value
        );
        if (tab === "git" && source?.target?.kind === "repository")
          return [
            {
              axis: tab,
              action: "set",
              repository: source.target.repository,
              expectedVersion
            }
          ];
        if (tab === "folder" && source?.target?.kind === "folder")
          return [
            {
              axis: tab,
              action: "set",
              folder: source.target.folder,
              expectedVersion
            }
          ];
        throw new Error("The selected source is no longer available.");
      }
    );
  };
  const confirm = async () => {
    if (!review) return;
    if (preview) {
      await apply(organizationEdit(review, [], preview.corrections));
      return;
    }
    setReviewing(true);
    setError("");
    try {
      setPreview(
        await reviewSourceCorrections(props.api, review, corrections())
      );
    } catch (cause) {
      setError(projectErrorMessage(cause));
    } finally {
      setReviewing(false);
    }
  };
  return (
    <ProjectPopup
      title="Correct source context"
      description={props.target.title}
      busy={busy || reviewing || confirming}
      onClose={props.onClose}
    >
      {!review && !error && <p role="status">Loading…</p>}
      {review && (
        <>
          <SourceContextStatus context={review.context} />
          {proposal &&
            draft.git === "current" &&
            draft.folder === "current" && (
              <div className="v1-pm-context-suggestion">
                <span className="v1-pm-context-suggested">
                  {proposal.projects.length > 0
                    ? "Suggested Project: "
                    : "Suggested Folder: "}
                  <strong>
                    {proposal.projects.length > 0
                      ? proposalProjectLabel(proposal)
                      : proposal.directory
                        ? folderLabel(proposal.directory).name
                        : "this Folder"}
                  </strong>
                  {proposal.projects.length === 0 &&
                    proposal.directory &&
                    folderLabel(proposal.directory).detail && (
                      <> · {folderLabel(proposal.directory).detail}</>
                    )}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || reviewing || confirming}
                  onClick={() => void acceptProposal(proposal)}
                >
                  Use
                </Button>
                <ProposalWhy
                  proposal={proposal}
                  {...(anchorName ? { anchor: anchorName } : {})}
                />
              </div>
            )}
          <Tabs
            value={axis}
            onValueChange={(value) => setAxis(value as "git" | "folder")}
          >
            <TabsList>
              <TabsTab value="git">Git Anchor</TabsTab>
              <TabsTab value="folder">Folder</TabsTab>
            </TabsList>
            {(["git", "folder"] as const).map((tab) => {
              const label = tab === "git" ? "Git Anchor" : "Folder";
              const assignment = review.context[tab];
              const current = effective<SourceContextFact>(assignment);
              const items = (
                tab === "git" ? sources.repositories : sources.folders
              ).filter((s) => s.target);
              const pending = review.context.sync?.[tab].state === "pending";
              return (
                <TabsPanel
                  key={tab}
                  value={tab}
                  className="v1-pm-context-panel"
                >
                  <div className="v1-pm-field">
                    <span>Assign to</span>
                    <ProjectChoice
                      label={`Assign ${label} to`}
                      value={draft[tab]}
                      options={[
                        {
                          value: "current",
                          label: sourceLabel(current, props.projects)
                        },
                        { value: "unresolved", label: `No ${label}` },
                        {
                          value: "reset",
                          label: `Original: ${sourceLabel(assignment.original, props.projects)}`
                        },
                        ...(accepted &&
                        tab ===
                          (accepted.kind === "repository" ? "git" : "folder")
                          ? [
                              {
                                value: SUGGESTED_SOURCE,
                                label:
                                  accepted.kind === "repository"
                                    ? (acceptedAnchor?.anchorDisplay ??
                                      "Suggested Git Anchor")
                                    : accepted.directory
                                      ? folderLabelText(accepted.directory)
                                      : "Suggested Folder"
                              }
                            ]
                          : []),
                        ...items.map((s) => ({
                          value: s.id,
                          label:
                            tab === "folder"
                              ? folderSourceLabel(s.detail)
                              : s.detail
                        }))
                      ]}
                      onChange={(value) => update(tab, value)}
                      disabled={busy || reviewing || confirming || pending}
                    />
                  </div>
                  <div className="v1-pm-context-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Remove ${label} reference`}
                      disabled={
                        busy ||
                        reviewing ||
                        confirming ||
                        pending ||
                        draft[tab] === "unresolved" ||
                        (draft[tab] === "current" && current.state !== "known")
                      }
                      onClick={() => update(tab, "unresolved")}
                    >
                      <Trash2 />
                      Remove
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Reset ${label} reference to original`}
                      disabled={
                        busy ||
                        reviewing ||
                        confirming ||
                        pending ||
                        draft[tab] === "reset" ||
                        (draft[tab] === "current" &&
                          assignment.correction.state === "original")
                      }
                      onClick={() => update(tab, "reset")}
                    >
                      <RefreshCw />
                      Reset to original
                    </Button>
                  </div>
                  <p className="v1-pm-context-original">
                    Original: {sourceLabel(assignment.original, props.projects)}
                  </p>
                </TabsPanel>
              );
            })}
          </Tabs>
          {preview && (
            <div className="v1-pm-impact">
              <span>Projects after change</span>
              {preview.projects
                .filter((p) => p.after)
                .map((p) => (
                  <Badge key={p.id} variant="outline">
                    {p.name}
                  </Badge>
                ))}
              {!preview.projects.some((p) => p.after) && (
                <Badge>Without a Project</Badge>
              )}
            </div>
          )}
        </>
      )}
      <ProjectError error={error} />
      <DialogFooter>
        <Button
          variant="outline"
          disabled={busy || reviewing || confirming}
          onClick={props.onClose}
        >
          Cancel
        </Button>
        <Button
          disabled={
            !review ||
            busy ||
            reviewing ||
            confirming ||
            (draft.git === "current" && draft.folder === "current")
          }
          onClick={() => void confirm()}
        >
          {busy
            ? "Saving…"
            : reviewing
              ? "Reviewing…"
              : preview
                ? "Save changes"
                : "Review changes"}
        </Button>
      </DialogFooter>
    </ProjectPopup>
  );
}
